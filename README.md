# Deskside Assist — deploy to Netlify

Two public URLs, no sign-in for the visitor, no API key in the browser.

## What's here

```
netlify.toml                    config
public/index.html               landing page
public/queue.html               morning queue (batch)
public/case.html                single case
netlify/functions/classify.js   the only thing that touches your API key
```

## Deploy

**1. Put it on GitHub.** Create a repo, upload this folder.

**2. Connect it to Netlify.** netlify.com → Add new site → Import an existing
project → pick the repo. Leave the build settings alone; `netlify.toml`
already sets the publish directory and the functions directory.

**3. Add your key.** Site configuration → Environment variables → Add:

```
GEMINI_API_KEY = <your key>
```

Get the key from aistudio.google.com/apikey. It never leaves the server.

Optionally also set `GEMINI_MODEL` if you want a model other than the default
`gemini-2.5-flash`. If deploys fail with "Classification service unavailable",
check the function log under Deploys → Functions → classify — a wrong model
name shows up there.

**4. Redeploy** once after adding the variable (Deploys → Trigger deploy).
Environment variables are read at build time.

Your URLs are then:

```
https://<your-site>.netlify.app/          landing
https://<your-site>.netlify.app/queue.html
https://<your-site>.netlify.app/case.html
```

Rename the site under Site configuration → Change site name to get something
like `deskside-assist.netlify.app`.

## Local test

```
npm install -g netlify-cli
netlify dev
```

Set `GEMINI_API_KEY` in a `.env` file first. Don't commit it.

## About the key

The browser never sees it. The page sends only the interaction text to
`/api/classify`, and the function builds the prompt and calls Gemini.

The function will only ever classify a bank interaction — the policy and the
prompt are hard-coded server-side, and input is capped at 1200 characters. So
nobody can point it at your key and use it as a general-purpose LLM proxy.

It has no rate limit. On a portfolio site that's usually fine, but each
classification costs you a fraction of a cent against your own API credits. If
you want a ceiling, set quota limits in Google AI Studio rather
than trying to do it in the function.
