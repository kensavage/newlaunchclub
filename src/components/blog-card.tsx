import Image from "next/image";
import type { BlogPost } from "@/lib/blog";
import { readingMinutes } from "@/lib/blog";

export function BlogCard({ post }: { post: BlogPost }) {
  return (
    <article className="blog-card">
      <a href={`/blog/${post.slug}`} className="blog-card-image" aria-label={`Read ${post.title}`}>
        {post.featuredImage ? (
          // WordPress owns this image source; a normal image keeps new posts working without config changes.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={post.featuredImage} alt="" />
        ) : (
          <span className="blog-card-image-empty" aria-hidden="true" />
        )}
      </a>
      <div className="blog-card-body">
        <div className="blog-author">
          <Image src="/internal/blog/author.png" alt="" width={42} height={42} />
          <div>
            <strong>{post.author}</strong>
            <span>{post.categories[0] ?? "AI"} · {readingMinutes(post)} min read</span>
          </div>
        </div>
        <h2>
          <a href={`/blog/${post.slug}`} dangerouslySetInnerHTML={{ __html: post.title }} />
        </h2>
        <div className="blog-excerpt" dangerouslySetInnerHTML={{ __html: post.excerpt }} />
        <time dateTime={post.date}>
          {new Intl.DateTimeFormat("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric"
          }).format(new Date(post.date))}
        </time>
      </div>
    </article>
  );
}
