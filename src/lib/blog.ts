const WORDPRESS_API = "https://launchclub.ai/blog/wp-json/wp/v2";

export type BlogPost = {
  id: number;
  slug: string;
  date: string;
  title: string;
  excerpt: string;
  content: string;
  featuredImage: string | null;
  author: string;
  categories: string[];
};

type WordPressPost = {
  id: number;
  slug: string;
  date: string;
  title: { rendered: string };
  excerpt: { rendered: string };
  content: { rendered: string };
  _embedded?: {
    author?: Array<{ name?: string }>;
    "wp:featuredmedia"?: Array<{ source_url?: string }>;
    "wp:term"?: Array<Array<{ name?: string }>>;
  };
};

const fallbackPosts: BlogPost[] = [
  {
    id: 1,
    slug: "the-competitor-siphon-how-to-ethically-steal-traffic-from-your-rivals-on-reddit",
    date: "2026-05-15T05:37:13",
    title: "The &quot;Competitor Siphon&quot;: How to Ethically Steal Traffic from Your Rivals on Reddit",
    excerpt:
      "Stop trying to manufacture demand from thin air. Your biggest competitors have already done the heavy lifting for you.",
    content: "",
    featuredImage: null,
    author: "Savage",
    categories: ["AI"]
  },
  {
    id: 2,
    slug: "the-shadowban-survival-guide-how-to-automate-your-reddit-growth-without-getting-nuked-by-admins",
    date: "2026-05-11T09:14:23",
    title: "The Shadowban Survival Guide: How to Automate Your Reddit Growth Without Getting Nuked by Admins",
    excerpt: "How to use automation without losing the trust that makes Reddit valuable.",
    content: "",
    featuredImage: "/internal/blog/23ce365226d10809.webp",
    author: "Savage",
    categories: ["AI"]
  },
  {
    id: 3,
    slug: "the-shadow-ranking-secret-how-to-siphon-traffic-from-threads-you-didnt-even-write",
    date: "2026-04-27T08:54:32",
    title: "The &quot;Shadow-Ranking&quot; Secret: How to Siphon Traffic from Threads You Didn't Even Write",
    excerpt: "Stop trying to beat Google. Start living inside of the Reddit results it already trusts.",
    content: "",
    featuredImage: "/internal/blog/6efbea2f844dadd8.webp",
    author: "Savage",
    categories: ["AI"]
  },
  {
    id: 4,
    slug: "the-anti-marketing-blueprint-how-to-sell-on-reddit-to-people-who-hate-being-sold-to",
    date: "2026-04-24T11:18:55",
    title: "The &quot;Anti-Marketing&quot; Blueprint: How to Sell on Reddit to People Who Hate Being Sold To",
    excerpt: "A practical framework for earning attention in communities that reject traditional ads.",
    content: "",
    featuredImage: "/internal/blog/c1d02f9860e9fa32.webp",
    author: "Savage",
    categories: ["AI"]
  },
  {
    id: 5,
    slug: "reddit-growth-secrets-revealed-how-to-piggyback-on-high-traffic-threads",
    date: "2026-04-22T11:14:17",
    title: "Reddit Growth Secrets Revealed: How to Piggyback on High-Traffic Threads",
    excerpt: "Find established conversations and add the answer buyers were already looking for.",
    content: "",
    featuredImage: "/internal/blog/079e95e4aae697a8.webp",
    author: "Savage",
    categories: ["AI"]
  },
  {
    id: 6,
    slug: "is-reddit-automation-bad-how-to-use-ai-without-looking-like-a-bot-full-guide",
    date: "2026-04-13T10:52:52",
    title: "Is Reddit Automation Bad? How to Use AI Without Looking Like a Bot (Full Guide)",
    excerpt: "Where AI helps, where it hurts, and how to keep every contribution genuinely useful.",
    content: "",
    featuredImage: "/internal/blog/fe5993b71cf98b99.webp",
    author: "Savage",
    categories: ["AI"]
  },
  {
    id: 7,
    slug: "the-reddit-warm-up-guide-how-to-build-authority-without-looking-like-a-spammer-3",
    date: "2026-04-08T10:25:26",
    title: "The Reddit Warm-Up Guide: How to Build Authority Without Looking Like a Spammer",
    excerpt: "Build account credibility before your brand ever needs to ask for attention.",
    content: "",
    featuredImage: "/internal/blog/10fcd9b72262ed25.webp",
    author: "Savage",
    categories: ["AI"]
  },
  {
    id: 8,
    slug: "the-reddit-warm-up-guide-how-to-build-authority-without-looking-like-a-spammer-2",
    date: "2026-04-08T10:23:55",
    title: "The Reddit Warm-Up Guide: How to Build Authority Without Looking Like a Spammer",
    excerpt: "A field guide to participating before promoting.",
    content: "",
    featuredImage: "/internal/blog/a7ad99b1521cdfee.webp",
    author: "Savage",
    categories: ["AI"]
  },
  {
    id: 9,
    slug: "the-reddit-warm-up-guide-how-to-build-authority-without-looking-like-a-spammer",
    date: "2026-04-08T09:43:32",
    title: "The Reddit Warm-Up Guide: How to Build Authority Without Looking Like a Spammer",
    excerpt: "The right way to earn trust in protective, highly informed communities.",
    content: "",
    featuredImage: "/internal/blog/1ccd84278eb965fd.webp",
    author: "Savage",
    categories: ["AI"]
  }
];

function normalizePost(post: WordPressPost): BlogPost {
  return {
    id: post.id,
    slug: post.slug,
    date: post.date,
    title: post.title.rendered,
    excerpt: post.excerpt.rendered,
    content: post.content.rendered,
    featuredImage: post._embedded?.["wp:featuredmedia"]?.[0]?.source_url ?? null,
    author: post._embedded?.author?.[0]?.name ?? "Savage",
    categories:
      post._embedded?.["wp:term"]?.flatMap((terms) => terms.flatMap((term) => term.name ?? [])) ??
      ["AI"]
  };
}

export async function getBlogPosts(page = 1, perPage = 9): Promise<BlogPost[]> {
  try {
    const response = await fetch(
      `${WORDPRESS_API}/posts?per_page=${perPage}&page=${page}&_embed=1`,
      { next: { revalidate: 900 } }
    );
    if (!response.ok) throw new Error("WordPress did not return posts");
    return ((await response.json()) as WordPressPost[]).map(normalizePost);
  } catch {
    return page === 1 ? fallbackPosts.slice(0, perPage) : [];
  }
}

export async function getBlogPost(slug: string): Promise<BlogPost | null> {
  try {
    const response = await fetch(
      `${WORDPRESS_API}/posts?slug=${encodeURIComponent(slug)}&_embed=1`,
      { next: { revalidate: 900 } }
    );
    if (!response.ok) throw new Error("WordPress did not return the post");
    const posts = (await response.json()) as WordPressPost[];
    return posts[0] ? normalizePost(posts[0]) : null;
  } catch {
    return fallbackPosts.find((post) => post.slug === slug) ?? null;
  }
}

export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&#8230;|&hellip;/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

export function readingMinutes(post: BlogPost): number {
  const words = plainText(post.content || post.excerpt).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 220));
}
