import { defineConfig } from "vitepress";

const base = process.env.DOCS_BASE ?? "/AgentClaw/";

export default defineConfig({
  title: "AgentClaw Engineering",
  description:
    "Engineering essays and system documentation for AgentClaw, an open-source AI agent framework.",
  base,
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: [
    "HIVE.md",
    "AUDIT-FIX-REPORT.md",
    "vsopenclawtask.md",
    "__pycache__/**",
    "从零到一造Agent/**",
  ],
  head: [
    ["link", { rel: "icon", href: `${base}logo.svg`, type: "image/svg+xml" }],
    ["meta", { name: "theme-color", content: "#101820" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "AgentClaw Engineering" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Field notes, architecture decisions, and production lessons from building reliable AI agents.",
      },
    ],
  ],
  themeConfig: {
    logo: { src: "/logo.svg", alt: "AgentClaw" },
    nav: [
      { text: "Blog", link: "/blog/" },
      { text: "Agent Series", link: "/blog/building-ai-agents/" },
      { text: "Guide", link: "/guide/" },
      { text: "Compare", link: "/compare/" },
    ],
    sidebar: {
      "/blog/building-ai-agents/": [
        {
          text: "Building AI Agent Frameworks",
          items: [
            { text: "Series Home", link: "/blog/building-ai-agents/" },
            {
              text: "Agent Loop Safety",
              link: "/blog/building-ai-agents/01-the-agent-loop",
            },
            {
              text: "Tool System Design",
              link: "/blog/building-ai-agents/02-tool-system-design",
            },
            {
              text: "Context Management",
              link: "/blog/building-ai-agents/03-context-management",
            },
            {
              text: "Memory Architecture",
              link: "/blog/building-ai-agents/04-memory-architecture",
            },
            {
              text: "Token Economy",
              link: "/blog/building-ai-agents/05-the-token-economy",
            },
            {
              text: "LLM Failure Handling",
              link: "/blog/building-ai-agents/06-when-llms-fail",
            },
            {
              text: "Security",
              link: "/blog/building-ai-agents/07-security",
            },
            {
              text: "Browser Automation",
              link: "/blog/building-ai-agents/08-browser-automation",
            },
            {
              text: "Multi-Channel Agents",
              link: "/blog/building-ai-agents/09-multi-channel",
            },
            {
              text: "Production Readiness",
              link: "/blog/building-ai-agents/10-production-readiness",
            },
          ],
        },
      ],
      "/blog/": [
        {
          text: "Engineering Blog",
          items: [
            { text: "Blog Home", link: "/blog/" },
            {
              text: "Memory Control System",
              link: "/blog/memory-control-system",
            },
            {
              text: "Context Compression",
              link: "/blog/context-compression",
            },
            {
              text: "Building AI Agent Frameworks",
              link: "/blog/building-ai-agents/",
            },
          ],
        },
      ],
      "/guide/": [
        {
          text: "System Guide",
          items: [
            { text: "Guide Home", link: "/guide/" },
            { text: "Architecture", link: "/guide/architecture" },
            { text: "Roadmap", link: "/guide/roadmap" },
            { text: "Engineering Lessons", link: "/guide/engineering-lessons" },
          ],
        },
      ],
      "/compare/": [
        {
          text: "Comparisons",
          items: [
            { text: "Compare Home", link: "/compare/" },
            {
              text: "AgentClaw vs OpenClaw",
              link: "/compare/agentclaw-vs-openclaw",
            },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/vorojar/AgentClaw" },
    ],
    search: {
      provider: "local",
    },
    outline: {
      level: [2, 3],
    },
    footer: {
      message: "Built from production traces, not imagined happy paths.",
      copyright: "AgentClaw Engineering",
    },
  },
});
