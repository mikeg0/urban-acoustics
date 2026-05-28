# Urban Quiet Initiative — deploy

Deployment assets for the Urban Quiet Initiative petition site — a Salt Lake City citizens' coalition pushing for a nighttime transportation-noise measurement pilot along the State Street corridor.

- **Live site:** https://urban-quiet-initiative.geo-tt.app/
- **Amplify default URL:** https://main.d3iawkfgvlagfs.amplifyapp.com/

The petition page is a single static HTML file hosted on AWS Amplify, alongside the `enforcement-map` demo page. Email signups go to a small AWS backend (API Gateway → Lambda → DynamoDB) defined as a CloudFormation/SAM stack in this directory.

## Repo layout

The petition page and the demo pages live with the rest of the frontend, so the Vite dev server serves them locally; the deploy assets and Lambda code live here under `deploy/quiet-initiative/`.

```
urban-acoustics/
├── deploy/
│   └── quiet-initiative/
│       ├── README.md           ← this file
│       ├── template.yaml       ← CloudFormation/SAM definition for the signup backend
│       ├── deploy-backend.sh   ← one-command deploy for the backend stack
│       ├── deploy-amplify.sh   ← one-command deploy for the three static sites
│       └── src/
│           └── index.mjs       ← Lambda handler (Node 20, ESM)
└── frontend/
    └── public/
        ├── quiet-initiative/
        │   └── index.html      ← the petition page
        └── enforcement-map/
            └── index.html
```

### Local preview

Running the urban-acoustics dev stack (`docker compose up`) makes both sites available under the dev domain:

- https://urban-acoustics.dev.conexed.com/quiet-initiative/
- https://urban-acoustics.dev.conexed.com/enforcement-map/

No Vite config changes are needed — `frontend/public/<name>/index.html` is served at `/<name>/` automatically.

---

## AWS resources

All resources live in account `174590856187`, region `us-west-2` (unless noted).

### Frontend / hosting (created imperatively, one-time setup)

| Resource | Identifier |
|---|---|
| Amplify app | `d3iawkfgvlagfs` |
| Amplify branch | `main` (production) |
| Custom domain | `urban-quiet-initiative.geo-tt.app` |
| ACM certificate | Amplify-managed (`*.urban-quiet-initiative.geo-tt.app`) |
| Route53 hosted zone | `Z047711126JFBTO0PE8KR` (`geo-tt.app`) |

### Backend / signup (managed by CloudFormation stack `urban-quiet-initiative-backend`)

| Resource | Identifier |
|---|---|
| Lambda function | `urban-quiet-signup` (Node 20, arm64) |
| API Gateway (HTTP API) | `POST /signup`, `POST /feedback` (ID varies on redeploy) |
| Signup endpoint | `https://fs0krnlxd0.execute-api.us-west-2.amazonaws.com/signup` |
| Feedback endpoint | `https://fs0krnlxd0.execute-api.us-west-2.amazonaws.com/feedback` |
| DynamoDB table (signups) | `urban-quiet-signups` (PK: `email`, PAY_PER_REQUEST, PITR enabled) |
| DynamoDB table (feedback) | `urban-quiet-feedback` (PK: `feedbackId`, PAY_PER_REQUEST, PITR enabled) |
| CFN deploy bucket | `urban-quiet-initiative-deploy-174590856187-us-west-2` |

Both DynamoDB tables have `DeletionPolicy: Retain` so deleting the stack does **not** delete collected data.

---

## Deploying the static sites (Amplify)

`deploy-amplify.sh` bundles the petition page and the `enforcement-map` demo from `frontend/public/` and uploads them to the Amplify app via the manual-deployment flow.

```bash
cd deploy/quiet-initiative
./deploy-amplify.sh
```

What it does:

1. Reads `frontend/public/{quiet-initiative,enforcement-map}/` from this repo.
2. Stages them into a single artifact, also copying `quiet-initiative/index.html` to the artifact root so the bare domain still serves the petition.
3. Zips the artifact, requests an Amplify deployment slot (`aws amplify create-deployment`), uploads the zip to the presigned URL, and starts the deployment.
4. Polls `aws amplify get-job` until the status is `SUCCEED` or `FAILED`.

Resulting URLs:

- `https://urban-quiet-initiative.geo-tt.app/` — petition (bare domain, unchanged from before)
- `https://urban-quiet-initiative.geo-tt.app/quiet-initiative/` — petition (same file, path-named)
- `https://urban-quiet-initiative.geo-tt.app/enforcement-map/` — enforcement-map demo

The petition is published at both `/` and `/quiet-initiative/` so existing bookmarks/QR codes pointing at the bare domain keep working while the path-named URL matches the local-dev URL for parity.

Env vars (override defaults):

| Var | Default |
|---|---|
| `AMPLIFY_APP_ID` | `d3iawkfgvlagfs` |
| `AMPLIFY_BRANCH` | `main` |
| `AWS_REGION` | `us-west-2` |

CloudFront caches the previous version aggressively. After a deploy, hit `https://urban-quiet-initiative.geo-tt.app/?bust=$(date +%s)` to bypass cache, or run an invalidation in the Amplify console if needed.

---

## Deploying the signup backend (CloudFormation)

Everything in this directory other than the Amplify script is the CloudFormation/SAM stack. To deploy or update:

```bash
cd deploy/quiet-initiative
./deploy-backend.sh
```

The script:

1. Creates the deploy bucket if it doesn't exist (idempotent).
2. Runs `aws cloudformation package` to upload Lambda code (`src/index.mjs`) to S3 and rewrite the template.
3. Runs `aws cloudformation deploy` to create or update the stack.
4. Prints the stack outputs (including the signup and feedback endpoint URLs).

Common edits and their effects:

- **Lambda code** → edit `src/index.mjs`, run `./deploy-backend.sh`. CloudFormation publishes a new Lambda version.
- **Lambda config (memory, timeout, env vars)** → edit `template.yaml`, run `./deploy-backend.sh`.
- **DynamoDB schema** → don't change `KeySchema` once you have real signups. Add GSIs or new attributes safely; PK changes require a manual migration.
- **API routes** → add new `HttpApi` events to the `SignupFunction` in `template.yaml`.

> ⚠️ If the API Gateway ID changes (e.g. you delete and recreate the stack), the endpoint URLs change too. Update the `endpoint` constants in `frontend/public/quiet-initiative/index.html` and redeploy the site. Stack-updates in place do *not* change the endpoint URLs.

Get the current endpoints at any time:

```bash
aws cloudformation describe-stacks \
  --stack-name urban-quiet-initiative-backend --region us-west-2 \
  --query 'Stacks[0].Outputs[?OutputKey==`SignupEndpoint`].OutputValue' --output text

aws cloudformation describe-stacks \
  --stack-name urban-quiet-initiative-backend --region us-west-2 \
  --query 'Stacks[0].Outputs[?OutputKey==`FeedbackEndpoint`].OutputValue' --output text
```

---

## Where signups are collected

The form on the site POSTs JSON `{ "email": "..." }` to the API Gateway endpoint. The Lambda validates the email, lowercases/trims it, then writes to DynamoDB with a conditional `attribute_not_exists(email)` so duplicates return `{ok: true, already: true}` rather than overwriting.

Each item in `urban-quiet-signups` contains:

| Attribute | Description |
|---|---|
| `email` | Partition key, lowercased |
| `createdAt` | ISO 8601 timestamp of the first signup |
| `userAgent` | Browser UA from the request |
| `sourceIp` | Source IP (from API Gateway request context) |

### Viewing signups

Quick list of emails:

```bash
aws dynamodb scan --table-name urban-quiet-signups --region us-west-2 \
  --query 'Items[].email.S' --output text
```

Full records with metadata:

```bash
aws dynamodb scan --table-name urban-quiet-signups --region us-west-2 \
  --query 'Items[].{email:email.S,when:createdAt.S,ip:sourceIp.S}' --output table
```

### Exporting to CSV

```bash
aws dynamodb scan --table-name urban-quiet-signups --region us-west-2 \
  --output json \
| python3 -c '
import json, sys, csv
data = json.load(sys.stdin)["Items"]
w = csv.writer(sys.stdout)
w.writerow(["email","createdAt","sourceIp","userAgent"])
for it in data:
    w.writerow([
        it.get("email",{}).get("S",""),
        it.get("createdAt",{}).get("S",""),
        it.get("sourceIp",{}).get("S",""),
        it.get("userAgent",{}).get("S",""),
    ])
' > signups.csv
```

### Counting signups

```bash
aws dynamodb scan --table-name urban-quiet-signups --region us-west-2 \
  --select COUNT --query 'Count'
```

### Deleting a signup

```bash
aws dynamodb delete-item --table-name urban-quiet-signups --region us-west-2 \
  --key '{"email":{"S":"someone@example.com"}}'
```

---

## DNS / SSL

- Hosted zone `geo-tt.app` (`Z047711126JFBTO0PE8KR`) lives in this same AWS account, so Amplify auto-created both records when the domain was attached:
  - `urban-quiet-initiative.geo-tt.app` A-ALIAS → CloudFront
  - `_<token>.urban-quiet-initiative.geo-tt.app` CNAME → ACM validation
- Cert is Amplify-managed and renews automatically.
- HTTP requests 301 to HTTPS automatically (CloudFront behavior).

---

## Smoke test

```bash
# Site is up
curl -sI https://urban-quiet-initiative.geo-tt.app/ | head -2
curl -sI https://urban-quiet-initiative.geo-tt.app/quiet-initiative/ | head -2
curl -sI https://urban-quiet-initiative.geo-tt.app/enforcement-map/ | head -2

# Signup endpoint works (replace with current endpoint if it changed)
ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name urban-quiet-initiative-backend --region us-west-2 \
  --query 'Stacks[0].Outputs[?OutputKey==`SignupEndpoint`].OutputValue' --output text)
curl -s -X POST -H 'content-type: application/json' \
  -d '{"email":"smoke-test@example.com"}' "$ENDPOINT"

# Cleanup the test entry
aws dynamodb delete-item --table-name urban-quiet-signups --region us-west-2 \
  --key '{"email":{"S":"smoke-test@example.com"}}'
```

---

## Tearing it all down

```bash
APP_ID=d3iawkfgvlagfs
REGION=us-west-2

# Frontend
aws amplify delete-domain-association --app-id "$APP_ID" \
  --domain-name urban-quiet-initiative.geo-tt.app --region "$REGION"
aws amplify delete-app --app-id "$APP_ID" --region "$REGION"

# Backend (DynamoDB tables are retained by stack policy — delete separately if desired)
aws cloudformation delete-stack \
  --stack-name urban-quiet-initiative-backend --region "$REGION"
aws cloudformation wait stack-delete-complete \
  --stack-name urban-quiet-initiative-backend --region "$REGION"

# Optional: delete the retained DynamoDB tables (loses all data)
aws dynamodb delete-table --table-name urban-quiet-signups --region "$REGION"
aws dynamodb delete-table --table-name urban-quiet-feedback --region "$REGION"

# Optional: delete the CFN deploy bucket
aws s3 rb s3://urban-quiet-initiative-deploy-174590856187-us-west-2 --force

# Route53 records under urban-quiet-initiative.geo-tt.app survive Amplify deletion;
# delete them manually if you want a clean zone.
```

---

## Appendix: manual Amplify deployment (fallback)

If `deploy-amplify.sh` is unavailable or you want to deploy a different artifact, this is the equivalent manual sequence:

```bash
APP_ID=d3iawkfgvlagfs
REGION=us-west-2

# 1. Build a deploy artifact (zip with the three site folders + a root index.html).

# 2. Request a manual deployment slot
read JOB_ID ZIP_URL < <(aws amplify create-deployment \
  --app-id "$APP_ID" --branch-name main --region "$REGION" \
  --query '[jobId,zipUploadUrl]' --output text)

# 3. Upload the zip to the presigned URL
curl -s -X PUT -H 'Content-Type: application/zip' --upload-file /tmp/deploy.zip "$ZIP_URL"

# 4. Kick off the deploy
aws amplify start-deployment \
  --app-id "$APP_ID" --branch-name main --job-id "$JOB_ID" --region "$REGION"

# 5. Poll until SUCCEED
aws amplify get-job --app-id "$APP_ID" --branch-name main --job-id "$JOB_ID" \
  --region "$REGION" --query 'job.summary.status'
```
