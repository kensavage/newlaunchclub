import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogCard } from "@/components/blog-card";
import { BlogHeader } from "@/components/blog-header";
import { ReportGenerator } from "@/components/report-generator";
import { SiteFooter } from "@/components/site-footer";
import { getBlogPost, getBlogPosts, plainText, readingMinutes } from "@/lib/blog";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const post = await getBlogPost((await params).slug);
  if (!post) return { title: "Article | Launch Club" };
  return {
    title: `${plainText(post.title)} | Launch Club`,
    description: plainText(post.excerpt).slice(0, 155)
  };
}

export default async function BlogArticlePage({
  params
}: {
  params: Promise<{ slug: string }>;
}) {
  const post = await getBlogPost((await params).slug);
  if (!post) notFound();
  const related = (await getBlogPosts(1, 4)).filter((item) => item.slug !== post.slug).slice(0, 3);

  return (
    <main className="blog-page blog-article-page">
      <BlogHeader />
      <article className="blog-article">
        <div className="blog-article-meta">
          <span>{post.categories[0] ?? "AI"}</span>
          <span>{readingMinutes(post)} min read</span>
          <time dateTime={post.date}>
            {new Intl.DateTimeFormat("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric"
            }).format(new Date(post.date))}
          </time>
        </div>
        <h1 dangerouslySetInnerHTML={{ __html: post.title }} />
        <div className="blog-article-author">
          <span>Written by</span> <strong>{post.author}</strong>
        </div>
        {post.featuredImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="blog-article-hero" src={post.featuredImage} alt="" />
        ) : null}
        {post.content ? (
          <div className="wordpress-content" dangerouslySetInnerHTML={{ __html: post.content }} />
        ) : (
          <div className="wordpress-content">
            <p>{plainText(post.excerpt)}</p>
            <p>
              <a href={`https://launchclub.ai/blog/${post.slug}`}>Read the original article</a>
            </p>
          </div>
        )}
      </article>

      {related.length ? (
        <section className="blog-related">
          <h2>More Reddit Secrets</h2>
          <div className="blog-grid">
            {related.map((item) => (
              <BlogCard post={item} key={item.id} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="blog-report-cta">
        <h2>See Where Reddit Is Talking To Your Prospects Without You</h2>
        <p>Generate your personalized AI Search &amp; Reddit Opportunity Report.</p>
        <ReportGenerator variant="footer" />
      </section>
      <SiteFooter />
    </main>
  );
}
