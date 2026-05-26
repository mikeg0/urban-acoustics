"""Train the Pi-side logistic regression head.

Reads the cache produced by :mod:`extract`, fits a standardiser + a
multinomial logistic regression, and saves the result as raw numpy
arrays in ``pi_head.npz`` — the Pi loads it with ``np.load`` and never
needs sklearn at inference time.

CV is stratified by class. We don't split by device/hour here because
the data volume in Track 1 is small enough that random stratification
gives more reliable metrics than a leave-one-group-out scheme; once we
have enough labels per (device, hour) we'll revisit.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import pathlib
from collections import Counter

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, confusion_matrix, f1_score
from sklearn.model_selection import StratifiedKFold
from sklearn.preprocessing import StandardScaler


log = logging.getLogger(__name__)


MODEL_VERSION_PREFIX = "pi-v"


@dataclasses.dataclass
class TrainResult:
    model_version: str
    label_map: list[str]
    overall_f1_macro: float
    per_source_f1_macro: dict[str, float]
    per_class_f1: dict[str, float]
    confusion_matrix: list[list[int]]
    classification_report: str
    n_train: int
    n_classes: int


def _load_cache(path: pathlib.Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    with np.load(path, allow_pickle=True) as data:
        features = data["features"].astype(np.float32, copy=False)
        labels = data["labels"].astype(str)
        sources = data["sources"].astype(str)
        ids = data["ids"].astype(str)
    if features.ndim != 2 or features.shape[0] != labels.shape[0]:
        raise SystemExit(
            f"cache {path} has inconsistent shapes: features={features.shape} labels={labels.shape}"
        )
    return features, labels, sources, ids


def _fit_and_score_cv(
    features: np.ndarray,
    labels: np.ndarray,
    sources: np.ndarray,
    *,
    n_splits: int,
) -> tuple[dict[str, float], np.ndarray, np.ndarray, list[str]]:
    """Run stratified K-fold and aggregate predictions.

    Returns (per_source_macro_f1, y_true_concat, y_pred_concat, classes).
    Predictions are aligned with ``labels`` and ``sources`` so per-source
    breakdowns are honest.
    """
    classes = sorted(set(labels.tolist()))
    class_counts = Counter(labels.tolist())
    eligible_splits = min(n_splits, min(class_counts.values()))
    if eligible_splits < 2:
        log.warning(
            "train: smallest class has %d examples — skipping CV, scoring on training data",
            min(class_counts.values()),
        )
        # Train+predict on the whole set; metrics will be optimistic but
        # at least let the user see the model is wired correctly.
        scaler = StandardScaler()
        x = scaler.fit_transform(features)
        clf = LogisticRegression(
            solver="lbfgs", max_iter=2000, class_weight="balanced",
        )
        clf.fit(x, labels)
        y_pred = clf.predict(x)
        per_source = _per_source_macro_f1(labels, y_pred, sources, classes)
        return per_source, labels, y_pred, classes

    skf = StratifiedKFold(n_splits=eligible_splits, shuffle=True, random_state=0)
    y_pred = np.empty_like(labels)
    for fold, (train_idx, test_idx) in enumerate(skf.split(features, labels)):
        scaler = StandardScaler()
        x_tr = scaler.fit_transform(features[train_idx])
        x_te = scaler.transform(features[test_idx])
        clf = LogisticRegression(
            solver="lbfgs", max_iter=2000, class_weight="balanced",
        )
        clf.fit(x_tr, labels[train_idx])
        y_pred[test_idx] = clf.predict(x_te)
        fold_f1 = f1_score(
            labels[test_idx], y_pred[test_idx], average="macro", labels=classes, zero_division=0,
        )
        log.info("train: fold %d/%d macro-F1=%.3f", fold + 1, eligible_splits, fold_f1)

    per_source = _per_source_macro_f1(labels, y_pred, sources, classes)
    return per_source, labels, y_pred, classes


def _per_source_macro_f1(
    y_true: np.ndarray, y_pred: np.ndarray, sources: np.ndarray, classes: list[str],
) -> dict[str, float]:
    out: dict[str, float] = {}
    out["overall"] = float(
        f1_score(y_true, y_pred, average="macro", labels=classes, zero_division=0)
    )
    for src in sorted(set(sources.tolist())):
        mask = sources == src
        if not mask.any():
            continue
        out[src] = float(
            f1_score(
                y_true[mask], y_pred[mask], average="macro", labels=classes, zero_division=0,
            )
        )
    return out


def _fit_final(features: np.ndarray, labels: np.ndarray) -> tuple[StandardScaler, LogisticRegression]:
    scaler = StandardScaler()
    x = scaler.fit_transform(features)
    clf = LogisticRegression(
        solver="lbfgs", max_iter=2000, class_weight="balanced",
    )
    clf.fit(x, labels)
    return scaler, clf


def _next_model_version(out_dir: pathlib.Path) -> str:
    """Pick the next ``pi-vN`` directory under ``out_dir.parent``.

    If the caller passed an explicit ``--out`` that already names a
    versioned dir (e.g. ``models/pi-v3``) we just use it verbatim.
    """
    if out_dir.name.startswith(MODEL_VERSION_PREFIX):
        return out_dir.name
    parent = out_dir.parent if out_dir.suffix == "" else out_dir.parent
    existing: list[int] = []
    if parent.exists():
        for p in parent.iterdir():
            if p.name.startswith(MODEL_VERSION_PREFIX):
                try:
                    existing.append(int(p.name[len(MODEL_VERSION_PREFIX):]))
                except ValueError:
                    continue
    next_n = (max(existing) if existing else 0) + 1
    return f"{MODEL_VERSION_PREFIX}{next_n}"


def _save_head(
    out_dir: pathlib.Path,
    *,
    scaler: StandardScaler,
    clf: LogisticRegression,
    model_version: str,
) -> None:
    """Save the head as raw numpy arrays so the Pi can load with np.load.

    Storing ``classes`` as ``object`` dtype is fine for ``np.load`` with
    ``allow_pickle=True`` — the Pi reads it back into a list. Coefs and
    intercepts are stored as float32 to keep the file small.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    np.savez(
        out_dir / "pi_head.npz",
        coef=clf.coef_.astype(np.float32),
        intercept=clf.intercept_.astype(np.float32),
        classes=np.asarray(clf.classes_, dtype=object),
        scaler_mean=scaler.mean_.astype(np.float32),
        scaler_scale=scaler.scale_.astype(np.float32),
        model_version=np.asarray(model_version),
    )


def _write_metrics(out_dir: pathlib.Path, result: TrainResult) -> None:
    (out_dir / "metrics.json").write_text(
        json.dumps(dataclasses.asdict(result), indent=2, sort_keys=True)
    )
    (out_dir / "label_map.json").write_text(
        json.dumps({i: cls for i, cls in enumerate(result.label_map)}, indent=2)
    )


def train(
    cache_path: pathlib.Path,
    *,
    out_dir: pathlib.Path,
    n_splits: int = 5,
) -> TrainResult:
    features, labels, sources, _ids = _load_cache(cache_path)
    if features.shape[0] == 0:
        raise SystemExit(f"cache {cache_path} is empty — nothing to train")

    log.info(
        "train: loaded %d rows, %d features, %d classes",
        features.shape[0], features.shape[1], len(set(labels.tolist())),
    )

    per_source_f1, y_true, y_pred, classes = _fit_and_score_cv(
        features, labels, sources, n_splits=n_splits,
    )

    per_class_f1 = {
        cls: float(score)
        for cls, score in zip(
            classes,
            f1_score(y_true, y_pred, average=None, labels=classes, zero_division=0),
        )
    }
    cm = confusion_matrix(y_true, y_pred, labels=classes).tolist()
    report = classification_report(
        y_true, y_pred, labels=classes, zero_division=0,
    )

    scaler, clf = _fit_final(features, labels)
    model_version = _next_model_version(out_dir)
    _save_head(out_dir, scaler=scaler, clf=clf, model_version=model_version)

    result = TrainResult(
        model_version=model_version,
        label_map=list(clf.classes_),
        overall_f1_macro=per_source_f1["overall"],
        per_source_f1_macro={
            k: v for k, v in per_source_f1.items() if k != "overall"
        },
        per_class_f1=per_class_f1,
        confusion_matrix=cm,
        classification_report=report,
        n_train=int(features.shape[0]),
        n_classes=len(classes),
    )
    _write_metrics(out_dir, result)
    log.info(
        "train: saved %s/pi_head.npz (model_version=%s overall macro-F1=%.3f)",
        out_dir, model_version, result.overall_f1_macro,
    )
    return result


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Train the Pi-side classifier head.")
    p.add_argument(
        "--cache",
        default="data/training/pi_cache.npz",
        help="Path to pi_cache.npz produced by app.training.extract.",
    )
    p.add_argument(
        "--out",
        required=True,
        help="Output directory. Names containing 'pi-vN' set the model_version; "
             "otherwise the next pi-vN is computed from sibling directories.",
    )
    p.add_argument("--cv-splits", type=int, default=5)
    return p


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s"
    )
    args = _build_parser().parse_args()
    train(
        pathlib.Path(args.cache),
        out_dir=pathlib.Path(args.out),
        n_splits=args.cv_splits,
    )


if __name__ == "__main__":
    main()
