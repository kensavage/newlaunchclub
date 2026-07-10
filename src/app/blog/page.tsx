import type { Metadata } from "next";
import { BlogCard } from "@/components/blog-card";
import { BlogHeader } from "@/components/blog-header";
import { SiteFooter } from "@/components/site-footer";
import { getBlogPosts } from "@/lib/blog";

export const metadata: Metadata = {
  title: "Blog | Launch Club",
  description: "Reddit marketing and AI-search visibility strategies from Launch Club."
};

export const dynamic = "force-dynamic";

export default async function BlogPage({
  searchParams
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const page = Math.max(1, Number.parseInt((await searchParams).page ?? "1", 10) || 1);
  const posts = await getBlogPosts(page, 9);

  return (
    <main className="blog-page">
      <BlogHeader />
      <section className="blog-index">
        <h1>Blog</h1>
        <div className="blog-grid">
          {posts.map((post) => (
            <BlogCard post={post} key={post.id} />
          ))}
        </div>
        <nav className="blog-pagination" aria-label="Blog pagination">
          {page > 1 ? <a href={`/blog?page=${page - 1}`}>Previous</a> : <span />}
          {posts.length === 9 ? <a href={`/blog?page=${page + 1}`}>Next</a> : null}
        </nav>
      </section>
      <SiteFooter />
    </main>
  );
}
