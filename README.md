# Multi-Account Instagram Feed Worker ✨📸

Note: the LLM that wrote this got stuck in GenZ mode. Sorry. -blopker

## The Lowdown (About This Project)

Yo! This is a Cloudflare Worker script designed to check the latest public posts from a list of target Instagram Business or Creator accounts. Think of it as your personal IG public feed aggregator. 💅

**How it Works:**

* **Scheduled Runs:** It runs automatically on a cron schedule (default is every 6 hours, peep `wrangler.toml`) using a Cloudflare Worker Cron Trigger.
* **IG Graph API:** It uses the Instagram Graph API's **Business Discovery** feature. This requires *your own* valid Instagram Access Token and the numeric ID of *your own* Instagram Business Account to make the requests.
* **Fetches Public Posts:** For each username in your target list, it grabs their latest 3 *publicly available* posts.
* **Stores in R2:** It saves the post data (caption, media URL, permalink, etc.) as a separate JSON file for each username in a Cloudflare R2 bucket (e.g., `instagram_feed_nasa.json`).
* **Cache Ready:** It sets `Cache-Control` headers on the R2 objects, so if you hook up a custom domain to your R2 bucket, Cloudflare's CDN can cache the JSON files like a boss. 🔥

**Heads Up / Limitations:**

* Requires *your own* Instagram Business/Creator account linked to a Facebook Page and a Facebook Developer App to get the necessary API token and account ID.
* Only works for *public* posts on *other* Instagram **Business or Creator** accounts. It can't see private accounts or regular personal accounts.
* Your Instagram Access Token needs to be kept fresh (Long-Lived Tokens expire ~60 days, so plan for renewal!).

## The Setup Glow Up 🚀

Follow these steps to get this worker running:

**1. Prerequisites:**

* Node.js and npm/yarn installed.
* A Cloudflare account (obvs).
* Wrangler CLI installed (`npm install -g wrangler` or `yarn global add wrangler`). Log in with `wrangler login`.
* An Instagram **Business or Creator Account** linked to a **Facebook Page**.
* A **Facebook Developer App** created on `developers.facebook.com` with the "Instagram Graph API" product added.

**2. Get IG API Credentials:**

* **Long-Lived User Access Token:** You need to generate this via your Facebook App. This token needs permissions like `instagram_basic` and `pages_show_list`. Follow Meta's guides carefully – it's a whole process. Secure this token!
* **Your Own Instagram Business Account ID:** You need the *numeric ID* of the Instagram Business Account linked to your token/Facebook Page. You can usually find this via the API itself (see previous instructions or Meta docs).

**3. Create Cloudflare R2 Bucket:**

* Go to your Cloudflare Dashboard -> R2.
* Click "Create bucket" and give it a unique name (e.g., `my-ig-feed-assets`). Note this name down.

**4. Configure `wrangler.toml`:**

* Make sure your `wrangler.toml` file looks something like this, replacing the placeholders:

    ```toml
    name = "multi-instagram-stalker-worker" # Or your worker name
    main = "src/index.js"                  # Entry point file
    compatibility_date = "2025-04-03"      # Use a recent date

    [triggers]
    crons = ["0 */6 * * *"] # Runs every 6 hours (adjust if needed)

    [vars]
    # Put YOUR numeric IG Business Account ID here
    MY_INSTAGRAM_BUSINESS_ACCOUNT_ID = "YOUR_OWN_INSTAGRAM_BUSINESS_ACCOUNT_ID" # <<< REPLACE

    [[r2_buckets]]
    binding = "INSTAGRAM_ASSETS_BUCKET" # How you access it in code
    bucket_name = "your-r2-bucket-name"  # <<< REPLACE with your R2 bucket name
    # preview_bucket_name = "your-preview-r2-bucket-name" # Optional for `wrangler dev`
    ```

**5. Set Your Secret Access Token:**

* **NEVER** put your access token directly in `wrangler.toml` or your code. Use Wrangler secrets. Open your terminal in the project directory and run:
    ```bash
    echo "YOUR_LONG_LIVED_ACCESS_TOKEN" | npx wrangler secret put INSTAGRAM_ACCESS_TOKEN
    ```
    (Replace `YOUR_LONG_LIVED_ACCESS_TOKEN` with your actual token).

**6. Customize Target Usernames:**

* Open the worker script file (e.g., `src/index.js`).
* Find the `TARGET_USERNAMES` array near the top and edit the list of Instagram usernames you want the worker to fetch posts from.
    ```javascript
    const TARGET_USERNAMES = [
      "instagram",
      "cloudflare",
      // Add or remove usernames here!
    ];
    ```

**7. Deploy the Worker:**

* Run this command in your project directory:
    ```bash
    npm run deploy
    ```

**8. (Optional but Recommended) Connect Custom Domain to R2:**

* Want clean URLs like `https://ig-assets.yourdomain.com/instagram_feed_nasa.json` and leverage CDN caching? Connect a domain/subdomain you own in Cloudflare to your R2 bucket.
* Go to Cloudflare Dashboard -> R2 -> Your Bucket -> Settings -> Custom Domains -> Connect Domain. Follow the instructions. Make sure the (sub)domain is proxied (orange cloud) in your Cloudflare DNS settings.

**9. Frontend Integration:**

* In your website's (e.g., Shopify) JavaScript, `Workspace` the specific JSON file you need from R2.
* If using a custom domain:
    ```javascript
    const username = 'nasa'; // Example
    const url = `https://ig-assets.yourdomain.com/instagram_feed_${username}.json`; // <<< Use your custom domain + filename pattern

    fetch(url)
      .then(response => response.json())
      .then(posts => {
        console.log(`Got posts for ${username}:`, posts);
        // Your code to display the posts...
      });
    ```
* If *not* using a custom domain (requires bucket to be public, less ideal): You'd need to use the public `*.r2.dev` URL provided in the R2 bucket settings.

## How to Use It / Triggering 🎮

* **Automatic:** The worker runs automatically based on the `crons` schedule in `wrangler.toml`.
* **Manual:** The template includes a basic manual trigger at the `/_manual_trigger_update` path, requiring a secret header (`X-Admin-Key`). You **must** change `'YOUR_SECRET_MANUAL_KEY'` in the code to something secure if you use this, or implement better auth. Access it via `https://your-worker-url/_manual_trigger_update` with the correct header set.
