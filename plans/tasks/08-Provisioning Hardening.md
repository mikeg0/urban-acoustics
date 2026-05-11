# 08 - Provisioning Hardening

## Goal

Add production-shaped device provisioning after the static-cert Phase 1 path is proven. This includes claim codes, CSR signing, certificate rotation, revocation, and optional first-boot setup flow.

The provisioning milestone is complete when a fresh device can redeem a one-time claim code, receive a per-device certificate, connect under its final identity, and rotate that certificate safely.

## Scope

- Add claim-code persistence.
- Add CSR validation and signing.
- Add one-shot claim redemption.
- Add bootstrap certificate ACLs.
- Add per-device certificate rotation.
- Add revocation checks.
- Add Pi first-boot provisioning flow.
- Add AP-mode/captive portal only if needed for actual deployment.

## Deliverables

Backend:

- Claim-code model/table.
- Device cert issuance endpoint or MQTT provisioning handler.
- Certificate renewal endpoint.
- Revocation support.
- Admin/dev command to create claim codes.

Broker:

- Bootstrap certificate ACLs.
- Per-device ACL generation or documented CN-to-topic policy.
- Revoked cert handling strategy.

Pi:

- `urban_acoustics/provisioning.py`
- first-boot claim-code flow.
- atomic cert/key install.
- bootstrap cert deletion after successful provisioning.
- rotation at 75 percent certificate lifetime.

Optional Pi setup surface:

- AP-mode setup service.
- Captive portal for WiFi credentials, claim code confirmation, location pin, and friendly name.

## Provisioning Flow

1. Device starts without a final `device.crt`.
2. Device generates an on-device private key and CSR.
3. Device authenticates using bootstrap credentials.
4. Device submits claim code, CSR, serial/MAC, location, and friendly name.
5. Backend validates one-shot claim code.
6. Backend creates device row if needed.
7. Backend signs CSR and records certificate fingerprint.
8. Device writes cert and key with `0600` permissions.
9. Device removes bootstrap credential.
10. Device reconnects as final device ID.

## Dependencies

- Static-cert end-to-end path from Tasks 02 through 06.
- Device and certificate schema from Task 03.
- MQTT ACL behavior from Task 02.

## Acceptance Criteria

- Claim code can be created and redeemed exactly once.
- Device receives a cert tied to one device ID.
- Device can publish only to `dev/{device_id}/#`.
- Revoked certificate can no longer authenticate.
- Renewal creates a new certificate and preserves old cert for a short grace period.
- Failed provisioning leaves enough local state/logging to retry.
- Bootstrap certificate has no telemetry or event publish privileges beyond provisioning.

## Risks

- Captive portal work can expand quickly. Keep it behind the core cert flow.
- Never ship broad bootstrap permissions.
- Certificate/key file permissions and atomic replacement matter on power-loss-prone devices.
