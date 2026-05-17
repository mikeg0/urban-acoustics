"""MQTT ingest worker package — entrypoint is ``app.ingest.mqtt``.

Kept empty so ``python -m app.ingest.mqtt`` doesn't pre-import the submodule
through the package and trip Python's "module-already-loaded" RuntimeWarning.
"""
