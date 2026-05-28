#!/usr/bin/env bash
# Deploy the urban-quiet-initiative Amplify site, bundling the petition page
# and the enforcement-map demo page into one artifact.
#
# Reads the static sites from ../../frontend/public/<name>/index.html
# (the same files Vite serves locally), assembles them into a deploy artifact
# with the petition page at both / and /quiet-initiative/, and pushes the
# artifact to the existing Amplify app via the manual-deployment flow.
#
# Requires: aws CLI v2 (with credentials), zip, curl.

set -euo pipefail

AMPLIFY_APP_ID="${AMPLIFY_APP_ID:-d3iawkfgvlagfs}"
AMPLIFY_BRANCH="${AMPLIFY_BRANCH:-main}"
REGION="${AWS_REGION:-us-west-2}"

HERE="$(cd "$(dirname "$0")" && pwd)"
PUBLIC_ROOT="$HERE/../../frontend/public"
SITES=(quiet-initiative enforcement-map)

echo "==> App: $AMPLIFY_APP_ID  Branch: $AMPLIFY_BRANCH  Region: $REGION"

# 1. Verify each source site exists.
for site in "${SITES[@]}"; do
  if [[ ! -f "$PUBLIC_ROOT/$site/index.html" ]]; then
    echo "ERROR: missing $PUBLIC_ROOT/$site/index.html" >&2
    exit 1
  fi
done

# 2. Stage the deploy artifact in a temp directory.
WORK="$(mktemp -d)"
STAGE="$WORK/site"
ZIP="$WORK/deploy.zip"
mkdir -p "$STAGE"
trap 'rm -rf "$WORK"' EXIT

echo "==> Staging artifact in $STAGE"
for site in "${SITES[@]}"; do
  mkdir -p "$STAGE/$site"
  cp -r "$PUBLIC_ROOT/$site/." "$STAGE/$site/"
done
# Petition page at the artifact root too, so the bare domain still serves it.
cp "$PUBLIC_ROOT/quiet-initiative/index.html" "$STAGE/index.html"

# Shared root-level assets referenced from the pages (e.g. /sensor-locations.geojson).
cp "$PUBLIC_ROOT/sensor-locations.geojson" "$STAGE/sensor-locations.geojson"
cp "$PUBLIC_ROOT/favicon.ico"      "$STAGE/favicon.ico"
cp "$PUBLIC_ROOT/favicon-180.png"  "$STAGE/favicon-180.png"

# 3. Zip the staged artifact.
echo "==> Zipping artifact"
(cd "$STAGE" && zip -qr "$ZIP" .)

# 4. Request an Amplify manual-deployment slot.
echo "==> Requesting deployment slot"
read -r JOB_ID ZIP_URL < <(aws amplify create-deployment \
  --app-id "$AMPLIFY_APP_ID" --branch-name "$AMPLIFY_BRANCH" --region "$REGION" \
  --query '[jobId,zipUploadUrl]' --output text)

# 5. Upload the artifact to the presigned URL.
echo "==> Uploading $(wc -c < "$ZIP") bytes (job $JOB_ID)"
curl -fsS -X PUT -H 'Content-Type: application/zip' --upload-file "$ZIP" "$ZIP_URL"

# 6. Start the deployment.
echo "==> Starting deployment"
aws amplify start-deployment \
  --app-id "$AMPLIFY_APP_ID" --branch-name "$AMPLIFY_BRANCH" \
  --job-id "$JOB_ID" --region "$REGION" >/dev/null

# 7. Poll until terminal status.
echo "==> Waiting for deployment to finish"
while true; do
  STATUS="$(aws amplify get-job \
    --app-id "$AMPLIFY_APP_ID" --branch-name "$AMPLIFY_BRANCH" \
    --job-id "$JOB_ID" --region "$REGION" \
    --query 'job.summary.status' --output text)"
  case "$STATUS" in
    SUCCEED)
      echo "==> Deployment SUCCEED (job $JOB_ID)"
      echo "    https://urban-quiet-initiative.geo-tt.app/"
      echo "    https://urban-quiet-initiative.geo-tt.app/quiet-initiative/"
      echo "    https://urban-quiet-initiative.geo-tt.app/enforcement-map/"
      exit 0
      ;;
    FAILED|CANCELLED)
      echo "==> Deployment $STATUS (job $JOB_ID)" >&2
      exit 1
      ;;
    *)
      sleep 3
      ;;
  esac
done
