#!/usr/bin/env bash
# Deploy the Urban Quiet Initiative signup backend (DynamoDB + Lambda + HTTP API)
# via CloudFormation, using the AWS SAM transform.
#
# Requires: aws CLI v2 with credentials configured.
# Idempotent: first run creates the stack and deploy bucket; later runs update in place.

set -euo pipefail

STACK_NAME="${STACK_NAME:-urban-quiet-initiative-backend}"
REGION="${AWS_REGION:-us-west-2}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
DEPLOY_BUCKET="${DEPLOY_BUCKET:-urban-quiet-initiative-deploy-${ACCOUNT_ID}-${REGION}}"

HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGED="$HERE/template.packaged.yaml"

echo "==> Account: $ACCOUNT_ID  Region: $REGION  Stack: $STACK_NAME"

# 1. Ensure the deploy bucket exists (idempotent).
if ! aws s3api head-bucket --bucket "$DEPLOY_BUCKET" --region "$REGION" 2>/dev/null; then
  echo "==> Creating deploy bucket: $DEPLOY_BUCKET"
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$DEPLOY_BUCKET" --region "$REGION"
  else
    aws s3api create-bucket --bucket "$DEPLOY_BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION"
  fi
  aws s3api put-bucket-versioning --bucket "$DEPLOY_BUCKET" \
    --versioning-configuration Status=Enabled
fi

# 2. Package: upload the Lambda code to S3 and rewrite the template to reference it.
echo "==> Packaging template"
aws cloudformation package \
  --template-file "$HERE/template.yaml" \
  --s3-bucket "$DEPLOY_BUCKET" \
  --output-template-file "$PACKAGED" \
  --region "$REGION" \
  >/dev/null

# 3. Deploy.
echo "==> Deploying stack"
aws cloudformation deploy \
  --template-file "$PACKAGED" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --region "$REGION"

# 4. Show outputs.
echo "==> Stack outputs"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs' --output table
