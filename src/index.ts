// src/index.ts

// --- Type Definitions ---

// Define the shape of our environment variables and bindings
interface Env {
	INSTAGRAM_ASSETS_BUCKET: R2Bucket; // Binding for our R2 bucket
	INSTAGRAM_ACCESS_TOKEN: string; // Secret access token
	MY_INSTAGRAM_BUSINESS_ACCOUNT_ID: string; // Your own IG Biz Account ID (numeric string)
	// Add any other secrets or vars from wrangler.toml here
}

// Define the structure of an Instagram media item from the API
interface InstagramMediaItem {
	id: string;
	caption?: string; // Captions are optional
	media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
	media_url?: string; // Usually present for IMAGE/VIDEO
	permalink: string;
	timestamp: string;
	thumbnail_url?: string; // Usually present for VIDEO
	// Note: Business Discovery doesn't easily give carousel children
}

// Define the structure for the expected Business Discovery API response
interface InstagramBusinessDiscoveryResponse {
	business_discovery?: {
		// This whole part might be missing if user not found/private
		media?: {
			// Media might be missing
			data: InstagramMediaItem[]; // The array of posts
		};
	};
	// Might include an error object at the root on failure too
	error?: any;
}

// Define the structure of the JSON we store in R2
interface ProcessedPost {
	id: string;
	url: string;
	timestamp: string;
	caption: string;
	media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
	display_url?: string; // Use thumbnail for video, media_url for image
}

// --- Worker Code ---

// List of usernames you wanna check out - add your targets here 🎯
// Using `as const` makes it a readonly tuple for slightly stricter typing
const TARGET_USERNAMES = [
	'instagram',
	'cloudflare',
	'nasa',
	// Add more usernames here!
] as const;

export default {
	/**
	 * Handles scheduled events (Cron Triggers).
	 * Uses ExportedHandler<Env> for strong typing on env
	 */
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log(`TIME TO SPILL THE TEA 💅: Cron Trigger ${event.cron} starting...`);
		ctx.waitUntil(fetchAndStoreMultipleFeeds(env));
	},

	/**
	 * Optional: Handles HTTP requests for manual triggering or debugging.
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		// Pls make this secret key actually secret lol
		if (url.pathname === '/_manual_trigger_update' && request.headers.get('X-Admin-Key') === 'YOUR_SECRET_MANUAL_KEY') {
			console.log(`Manual trigger? Bet. Let's get the tea...`);
			ctx.waitUntil(fetchAndStoreMultipleFeeds(env));
			return new Response('Manual IG R2 update for multiple accounts triggered. Check logs! 🚀', { status: 200 });
		}
		return new Response('Worker up. Cron trigger does the magic, or hit the secret manual endpoint.', { status: 200 });
	},
} satisfies ExportedHandler<Env>; // Ensures the export matches the Worker handler type

/**
 * Fetches latest public posts for multiple usernames using Business Discovery
 * and stores each in a separate R2 file.
 * @param env Environment variables and bindings.
 */
async function fetchAndStoreMultipleFeeds(env: Env): Promise<void> {
	const {
		INSTAGRAM_ACCESS_TOKEN: ACCESS_TOKEN,
		MY_INSTAGRAM_BUSINESS_ACCOUNT_ID: OWN_IG_ACCOUNT_ID,
		INSTAGRAM_ASSETS_BUCKET: R2_BUCKET,
	} = env;

	// Basic checks - gotta have the essentials
	if (!ACCESS_TOKEN || !OWN_IG_ACCOUNT_ID || !R2_BUCKET) {
		console.error('☠️ Bro, setup failed. Missing Token, Your Own IG Account ID, or R2 Bucket binding.');
		return;
	}

	console.log(`Ok, preparing to check vibes for: ${TARGET_USERNAMES.join(', ')}`);

	// Let's process all targets concurrently, even if some fail
	// `Promise.allSettled` returns PromiseSettledResult<string>[] here because getAndStoreFeedForUser returns Promise<string>
	const results = await Promise.allSettled(
		TARGET_USERNAMES.map((username) =>
			// We trim() just in case there's accidental whitespace in the array
			getAndStoreFeedForUser(username.trim(), env, OWN_IG_ACCOUNT_ID),
		),
	);

	// Log the aftermath
	results.forEach((result, index) => {
		const username = TARGET_USERNAMES[index];
		if (result.status === 'fulfilled') {
			// result.value is the success message string
			console.log(`✅ Success for ${username}: ${result.value}`);
		} else {
			// result.reason is the error that was thrown
			console.error(`❌ Fail for ${username}: ${result.reason}`);
		}
	});

	console.log('Finished the run. Check R2! ✨');
}

/**
 * Fetches and stores feed for a single target username.
 * @param targetUsername The username to look up.
 * @param env Environment variables.
 * @param ownIgAccountId The user's own IG Business Account ID.
 * @returns Success message string or throws an error.
 */
async function getAndStoreFeedForUser(targetUsername: string, env: Env, ownIgAccountId: string): Promise<string> {
	const { INSTAGRAM_ACCESS_TOKEN: ACCESS_TOKEN, INSTAGRAM_ASSETS_BUCKET: R2_BUCKET } = env;
	const INSTAGRAM_API_VERSION: string = 'v19.0'; // Or latest
	const mediaFields: string = 'id,caption,media_type,media_url,permalink,timestamp,thumbnail_url';
	const limit: number = 3;

	// Construct the Business Discovery API URL
	const apiUrl: string =
		`https://graph.facebook.com/${INSTAGRAM_API_VERSION}/${ownIgAccountId}` +
		`?fields=business_discovery.username(${targetUsername}){media.limit(${limit}){${mediaFields}}}` +
		`&access_token=${ACCESS_TOKEN}`;

	console.log(`[${targetUsername}] Hitting API: ${apiUrl.replace(ACCESS_TOKEN, 'REDACTED_TOKEN')}`);

	try {
		const response = await fetch(apiUrl);

		if (!response.ok) {
			const errorText = await response.text();
			console.error(`[${targetUsername}] API Error ${response.status}: ${errorText}`);
			// Try to parse error JSON from Meta for more details, if possible
			try {
				const errorJson = JSON.parse(errorText);
				if (errorJson?.error?.message) {
					throw new Error(`API request failed for ${targetUsername}: ${response.status} - ${errorJson.error.message}`);
				}
			} catch (parseError) {
				// Ignore parsing error, just throw the original text
			}
			throw new Error(`API request failed for ${targetUsername} with status ${response.status}`);
		}

		// Explicitly type the parsed JSON response
		const apiData = await response.json<InstagramBusinessDiscoveryResponse>();

		// Use optional chaining (?.) to safely access potentially missing nested props
		const posts = apiData?.business_discovery?.media?.data;

		// Check if discovery worked and media exists and has posts
		if (!posts || posts.length === 0) {
			let reason = 'No public business discovery media found.';
			if (posts && posts.length === 0) {
				reason = 'No public posts returned in the media field.';
			} else if (apiData?.error) {
				reason = `API returned an error object: ${JSON.stringify(apiData.error)}`;
			}
			console.log(`[${targetUsername}] ${reason} Maybe private or not a biz account?`);

			// Write empty array to R2 to signify no public posts found / error
			const emptyData: string = JSON.stringify([]);
			// Use consistent naming convention for the R2 object key
			const safeUsername = targetUsername.replace(/[^a-zA-Z0-9_.-]/g, '_');
			const objectKey = `instagram_feed_${safeUsername}.json`;

			await R2_BUCKET.put(objectKey, emptyData, {
				httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' }, // Short cache for empty/error
			});
			return `${reason} Stored empty array for ${targetUsername}.`;
		}

		// Process posts into our desired format
		const postsForFrontend: ProcessedPost[] = posts.map(
			(post: InstagramMediaItem): ProcessedPost => ({
				id: post.id,
				url: post.permalink,
				timestamp: post.timestamp,
				caption: post.caption ?? '', // Use nullish coalescing for safety
				media_type: post.media_type,
				display_url: post.media_type === 'VIDEO' ? post.thumbnail_url : post.media_url,
			}),
		);

		// Generate filename and store in R2
		const jsonData: string = JSON.stringify(postsForFrontend, null, 2); // Pretty print JSON
		const safeUsername = targetUsername.replace(/[^a-zA-Z0-9_.-]/g, '_');
		const objectKey = `instagram_feed_${safeUsername}.json`;

		console.log(`[${targetUsername}] Writing ${jsonData.length} bytes to R2 key: ${objectKey}`);
		await R2_BUCKET.put(objectKey, jsonData, {
			httpMetadata: {
				contentType: 'application/json',
				// Cache for 10 mins on CDN via custom domain
				cacheControl: 'public, max-age=600',
			},
		});

		return `Successfully stored ${postsForFrontend.length} posts for ${targetUsername} in ${objectKey}`;
	} catch (error: unknown) {
		// Catch as unknown, then check type
		const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
		console.error(`[${targetUsername}] Error in getAndStoreFeedForUser: ${errorMessage}`);
		// Log stack trace if available
		if (error instanceof Error && error.stack) {
			console.error(error.stack);
		}
		// Re-throw the error so Promise.allSettled catches it as 'rejected'
		throw error;
	}
}
