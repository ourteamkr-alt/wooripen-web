# ChatGPT Ads CRM routing

Paid ChatGPT landing URLs must include `utm_source=chatgpt&utm_medium=paid`.
The existing consultation endpoint passes attribution to the server-side CRM integration.
Successful applications with that pair use intake group 196; all other sources keep group 116.
CRM delivery rule 9 forwards group 196 to company 171 (바인컴즈_토스), group 197.
The receiving group performs automatic counselor assignment using its active counselor list.

Validation: `node --experimental-strip-types --test scripts/crmpro-routing.test.mjs` and `npx tsc --noEmit`.
Tests mock CRM transport and do not create real CRM records.

Deployment changes must be merged into main before the next main deployment to prevent regression.
