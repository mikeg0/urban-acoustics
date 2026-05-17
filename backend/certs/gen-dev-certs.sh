#!/usr/bin/env bash
# Generate the dev mTLS PKI for Phase 1 cloud foundation.
#
# Outputs (all written next to this script):
#   root-ca.{key,crt}           Self-signed root CA. Pinned by clients.
#   mosquitto.{key,crt}         Broker server cert. SAN covers localhost +
#                               the in-cluster hostname `mosquitto`.
#   ingest.{key,crt}            Client cert for the MQTT ingest worker.
#                               CN = "ingest" — matches aclfile rule.
#   devices/<uuid>.{key,crt}    Per-device client certs. CN = the UUID
#                               (must equal the device_id used in topics).
#
# Re-running is idempotent: existing files are kept; pass --force to wipe
# and start over. Devices are generated from $DEVICE_IDS (space-separated
# UUIDs) or, if unset, a fixed pair of fixtures matching the simulator/test
# golden payloads.
#
# Production note: this script ships hard-coded dev defaults (no passphrases,
# 10-year validity). Phase 1 acceptance only requires a working dev PKI;
# real provisioning lands in task 08.

set -euo pipefail

CERT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVICES_DIR="${CERT_DIR}/devices"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      sed -n '2,/^set -e/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$FORCE" -eq 1 ]]; then
  echo ">> --force: clearing existing certs"
  rm -f  "${CERT_DIR}"/root-ca.* "${CERT_DIR}"/mosquitto.* "${CERT_DIR}"/ingest.*
  rm -rf "${DEVICES_DIR}"
fi

mkdir -p "${DEVICES_DIR}"

DAYS=3650
KEY_BITS=2048

# ---- root CA ---------------------------------------------------------------
if [[ ! -f "${CERT_DIR}/root-ca.crt" ]]; then
  echo ">> generating root CA"
  openssl genrsa -out "${CERT_DIR}/root-ca.key" "${KEY_BITS}" 2>/dev/null
  openssl req -x509 -new -nodes -sha256 -days "${DAYS}" \
    -key "${CERT_DIR}/root-ca.key" \
    -subj "/CN=urban-acoustics dev root CA" \
    -out "${CERT_DIR}/root-ca.crt"
fi

# ---- helper: sign a CSR with the root CA ----------------------------------
# args: <name> <subject-CN> <extfile-or-empty>
sign_cert() {
  local name="$1" cn="$2" ext="$3" dir="${4:-$CERT_DIR}"
  local key="${dir}/${name}.key"
  local csr="${dir}/${name}.csr"
  local crt="${dir}/${name}.crt"

  if [[ -f "$crt" ]]; then
    return 0
  fi
  echo ">> generating ${name} (CN=${cn})"
  openssl genrsa -out "$key" "${KEY_BITS}" 2>/dev/null
  openssl req -new -key "$key" -subj "/CN=${cn}" -out "$csr"
  if [[ -n "$ext" ]]; then
    openssl x509 -req -in "$csr" -sha256 -days "${DAYS}" \
      -CA "${CERT_DIR}/root-ca.crt" -CAkey "${CERT_DIR}/root-ca.key" -CAcreateserial \
      -extfile "$ext" -out "$crt" 2>/dev/null
  else
    openssl x509 -req -in "$csr" -sha256 -days "${DAYS}" \
      -CA "${CERT_DIR}/root-ca.crt" -CAkey "${CERT_DIR}/root-ca.key" -CAcreateserial \
      -out "$crt" 2>/dev/null
  fi
  # Dev-only: world-readable so bind-mounted containers (mosquitto runs as
  # uid 1883, minio as uid 1000) can read the key without uid/gid juggling.
  # Real deployments must keep private keys at mode 600 with owner-specific
  # access; the cert script in task 08 will enforce that for the Pi image.
  chmod 644 "$key"
  rm -f "$csr"
}

# ---- broker server cert ----------------------------------------------------
SERVER_EXT="$(mktemp)"
cat >"$SERVER_EXT" <<'EOF'
subjectAltName = DNS:mosquitto, DNS:localhost, DNS:urban-acoustics-mosquitto, IP:127.0.0.1
extendedKeyUsage = serverAuth
EOF
sign_cert "mosquitto" "mosquitto" "$SERVER_EXT"
rm -f "$SERVER_EXT"

# ---- ingest client cert ----------------------------------------------------
CLIENT_EXT="$(mktemp)"
cat >"$CLIENT_EXT" <<'EOF'
extendedKeyUsage = clientAuth
EOF
sign_cert "ingest" "ingest" "$CLIENT_EXT"

# ---- device client certs ---------------------------------------------------
# Default fixtures: stable UUIDs the simulator + tests can rely on.
DEVICE_IDS="${DEVICE_IDS:-00000000-0000-4000-8000-00000000000a 00000000-0000-4000-8000-00000000000b}"

for did in $DEVICE_IDS; do
  sign_cert "${did}" "${did}" "$CLIENT_EXT" "${DEVICES_DIR}"
done

rm -f "$CLIENT_EXT" "${CERT_DIR}/root-ca.srl"

echo
echo "PKI ready in ${CERT_DIR}"
echo "  CA:       root-ca.crt"
echo "  broker:   mosquitto.crt / mosquitto.key"
echo "  ingest:   ingest.crt / ingest.key"
echo "  devices:  $(ls "${DEVICES_DIR}" | grep '\.crt$' | tr '\n' ' ')"
