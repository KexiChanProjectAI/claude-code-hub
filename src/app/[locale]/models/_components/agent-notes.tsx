import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// No Tailwind typography plugin in this project, so style the elements directly.
const markdownComponents: Components = {
  h1: ({ children }) => <h2 className="mt-4 mb-2 text-lg font-semibold first:mt-0">{children}</h2>,
  h2: ({ children }) => (
    <h3 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h3>
  ),
  h3: ({ children }) => (
    <h4 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h4>
  ),
  h4: ({ children }) => <h5 className="mt-3 mb-1 text-sm font-medium first:mt-0">{children}</h5>,
  p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
  hr: () => <hr className="my-4 border-border" />,
};

interface AgentNotesProps {
  markdown: string | null;
  title: string;
}

/** Admin-authored notes, rendered from Markdown with HTML sanitized. */
export function AgentNotes({ markdown, title }: AgentNotesProps) {
  if (!markdown) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        <ReactMarkdown rehypePlugins={[rehypeSanitize]} components={markdownComponents}>
          {markdown}
        </ReactMarkdown>
      </CardContent>
    </Card>
  );
}
