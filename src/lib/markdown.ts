/** Markdown → Lexical conversion, using the resolved editor config off the
 *  live Payload instance (the imported config is a Promise until resolved). */
import type { Payload } from "payload";
import { convertMarkdownToLexical, editorConfigFactory } from "@payloadcms/richtext-lexical";

export async function markdownToLexical(payload: Payload, markdown: string) {
  const editorConfig = await editorConfigFactory.default({ config: payload.config });
  return convertMarkdownToLexical({ editorConfig, markdown });
}
