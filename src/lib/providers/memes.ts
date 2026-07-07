import { fetchJson } from "@/lib/providers/http";
import type { MemeConcept } from "@/lib/report/schema";

interface MemesAiResponse {
  memes?: Array<{
    title?: string;
    imageUrl?: string;
    url?: string;
  }>;
  images?: Array<{
    title?: string;
    imageUrl?: string;
    url?: string;
  }>;
}

export class MemesProvider {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string
  ) {}

  async generateMemeImages({
    concepts,
    companyName,
    category
  }: {
    concepts: MemeConcept[];
    companyName: string;
    category: string;
  }): Promise<MemeConcept[]> {
    const response = await fetchJson<MemesAiResponse>(this.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        companyName,
        category,
        memes: concepts.map((concept) => ({
          title: concept.title,
          prompt: concept.prompt,
          format: concept.format
        }))
      }),
      timeoutMs: 45_000
    });
    const generated = response.memes ?? response.images ?? [];

    return concepts.map((concept) => {
      const match = generated.find((item) => item.title === concept.title) ?? generated.shift();
      const imageUrl = match?.imageUrl ?? match?.url;

      return imageUrl
        ? {
            ...concept,
            imageUrl
          }
        : concept;
    });
  }
}
