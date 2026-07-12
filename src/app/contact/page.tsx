import type { Metadata } from "next";
import Image from "next/image";
import { ChevronDown, Paperclip } from "lucide-react";
import { InternalHero } from "@/components/internal-hero";
import { ReportGenerator } from "@/components/report-generator";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  title: "Contact | Launch Club",
  description: "Talk with the Launch Club team about Reddit and AI-search visibility."
};

const faqs = [
  {
    question: "What do you need to get started?",
    answer:
      "Once we know about your business using the onboarding info you provide, we research the posts already appearing in AI search platforms and ranking in Google. Then we start placing useful comments and brand mentions in the strongest Reddit threads."
  },
  {
    question: "Do you use AI to write your posts and comments?",
    answer:
      "We may use AI for inspiration and research, but every post and comment is edited and approved by a human."
  },
  {
    question: "Can I pause or cancel any time?",
    answer:
      "Of course. Most clients see the strongest compounding effect after three months, but you stay in control of your plan."
  },
  {
    question: "What does this cost?",
    answer:
      "Pricing starts at $2,500. The exact plan depends on your needs and how quickly you want to grow."
  }
] as const;

export default async function ContactPage({
  searchParams
}: {
  searchParams: Promise<{ submitted?: string }>;
}) {
  const submitted = (await searchParams).submitted === "1";

  return (
    <main className="internal-page contact-page">
      <InternalHero
        title="Contact Us"
        subtitle="Have any questions about our product? Our team is here to assist you every step of the way."
      />

      <section className="contact-main">
        <div className="contact-heading">
          <p className="internal-kicker">(Get in Touch)</p>
          <h2>Tell Us What You Need</h2>
          <p>Whether you&apos;re ready to scale or just exploring, we&apos;re here to help.</p>
        </div>

        <div className="contact-form-wrap">
          <Image
            className="contact-envelope"
            src="/internal/about/voxel-envelope.png"
            alt=""
            width={103}
            height={215}
          />
          {submitted ? (
            <div className="contact-success" role="status">
              <h3>Thanks. Your message is on its way.</h3>
              <p>We&apos;ll get back to you shortly.</p>
            </div>
          ) : (
            <form
              className="contact-form"
              name="launchclub-contact"
              method="POST"
              action="/contact?submitted=1"
              data-netlify="true"
              encType="multipart/form-data"
            >
              <input type="hidden" name="form-name" value="launchclub-contact" />
              <label>
                <span>First Name</span>
                <input type="text" name="first-name" required />
              </label>
              <label>
                <span>Last Name</span>
                <input type="text" name="last-name" required />
              </label>
              <label className="contact-wide">
                <span>Email</span>
                <input type="email" name="email" required />
              </label>
              <label className="contact-wide">
                <span>Phone Number</span>
                <input type="tel" name="phone" />
              </label>
              <label className="contact-wide">
                <span>How can we help you today?</span>
                <textarea name="message" rows={7} required />
              </label>
              <label className="contact-file contact-wide">
                <Paperclip size={18} aria-hidden="true" />
                <span>Attach a file</span>
                <input type="file" name="attachment" />
              </label>
              <button className="internal-green-button contact-wide" type="submit">
                Get in touch
              </button>
            </form>
          )}
        </div>
      </section>

      <section className="contact-faq">
        <header>
          <p className="internal-kicker">(Frequently Asked Questions)</p>
          <h2>Still Curious? Here&apos;s What Most People Ask</h2>
        </header>
        <div>
          {faqs.map((faq, index) => (
            <details key={faq.question} open={index === 0}>
              <summary>
                <strong>{faq.question}</strong>
                <ChevronDown size={25} aria-hidden="true" />
              </summary>
              <p>{faq.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="contact-report-cta">
        <h2>Ready to Tap Into <strong>Reddit Traffic?</strong></h2>
        <p>See which Reddit threads and AI-search opportunities are waiting for your brand.</p>
        <ReportGenerator variant="footer" source="contact_footer" />
      </section>
      <SiteFooter />
    </main>
  );
}
