# PidginCore website

This folder holds the static website for PidginCore. It has no accounts, no scripts, no trackers and no external fonts.

## Layout

- `public/` holds the pages, the style sheet and the images.
- `public/_headers` sets the security headers for the Cloudflare Worker deployment only.
- `wrangler.jsonc` configures the Cloudflare Worker deployment. It serves `public/` and nothing else.
- `.github/workflows/pages.yml` publishes `public/` to GitHub Pages.
- `check.mjs` checks the pages. See "Check the site" below.

## Preview the site

Run this command from the repository root:

```sh
python3 -m http.server 8080 --directory site/public
```

Open `http://127.0.0.1:8080/`. Do not open the files with `file://`. The links start at the site root, so they need a web server.

## Check the site

```sh
node site/check.mjs
```

The check needs Node.js 20 or later. It has no dependencies. It fails if one of these is true:

- An internal link or an in-page anchor does not point to a file or an element.
- A page has no title, no `lang` attribute, no meta description, no skip link or not exactly one `h1`.
- A page has a script, a style element, an inline style or an image without `alt` text.
- A page points to an outside origin other than `github.com/ashrocket/pidgindocs` and `duva.work`.
- A color pair in the style sheet is below its contrast limit.

The GitHub workflow `Verify` runs this check.

## Deploy

**Do not deploy this site without the approval of the project owner.**

### GitHub Pages

The owner publishes the site on GitHub Pages with these steps, in order:

1. Wait until the older hosted app no longer serves pidgindocs.com.
2. In the repository settings, set Pages to build from GitHub Actions.
3. Run the Site workflow by hand once. Check that the run succeeds. Until step 4, GitHub publishes the site below `ashrocket.github.io/pidgindocs/`. The links start at the site root, so the pages have no style and the links fail at that address. That is correct.
4. In the Pages settings, set the custom domain to pidgindocs.com. A CNAME file is not used when Pages publishes from a workflow.
5. In Cloudflare DNS, point the apex at GitHub Pages as GitHub's custom domain documentation describes. Add a `www` CNAME record to `ashrocket.github.io`.
6. Turn on Enforce HTTPS. GitHub must issue a certificate first. This can take some time, and a proxied Cloudflare record can delay it.
7. Set the repository variable `SITE_ON_GITHUB_PAGES` to `true`. Later pushes to `site/` then publish by themselves.

GitHub Pages does not read `_headers`. The Content Security Policy and the other headers in that file are not sent there. If the DNS record is proxied through Cloudflare, a response header rule can add them back.

### Cloudflare Worker

This is the earlier way to serve the site. It stays available.

Today, `pidgindocs.com` serves an older hosted app. The route in `wrangler.jsonc` is a Custom Domain for `pidgindocs.com`. A deploy makes this Worker the one that serves that name. The older app stops serving it.

Before the owner approves a deploy:

1. Check in the Cloudflare dashboard how `pidgindocs.com` is set up now. Find the Worker, the route or the DNS record that serves it.
2. Plan the change. Cloudflare does not let you create a Custom Domain on a hostname that has a CNAME record. The owner may need to remove or detach the older setup first.
3. Check the site with `node site/check.mjs`.
4. Test the configuration with `npx wrangler deploy --dry-run --config site/wrangler.jsonc`. This command does not change your account.

The owner then deploys with this command:

```sh
npx wrangler deploy --config site/wrangler.jsonc
```

The configuration has no account ID. Wrangler uses the account that you sign in to. Make sure that it is the right account.

The configuration sets `workers_dev` to `false`. The site has no `workers.dev` address.

## Change the site

- Write all text in Simplified Technical English. Use short sentences and active voice.
- Add no scripts, no analytics and no external resources. The Content Security Policy in `_headers` blocks them.
- Keep claims true. Check each feature claim against the code in `server/`.
- Do not describe a feature as available if its code is not in this repository.
- Run `node site/check.mjs` before you commit.
