## 1. Product Vision

A minimalist, local-first desktop application for real-time collaborative document creation. The core differentiator is the deep integration of personalized, context-aware AI agents (Writers and Reviewers) that act as active participants in the collaborative session. The app operates completely serverless, utilizing peer-to-peer local tunnels for sharing, and ensures every keystroke and AI modification is strictly version-controlled and attributed.
users should be able to use a llm provider with its endpoint and key (select it when app starts-not mandatory) or connect its own claude or codex using locally running mcp that enalbes the agents to work with the opened document.  

## 2. Technical Stack

|**Component**|**Technology**|**Purpose**|
|---|---|---|
|**App Framework**|Electron (React/Vite recommended)|Cross-platform desktop environment, filesystem access.|
|**Editor**|Tiptap|Headless rich-text editor, block-level manipulation, `@` mentions, inline comments.|
|**State & Sync**|Loro (CRDT)|Real-time state synchronization, out-of-the-box undo/redo, detailed change tracing, and versioning.|
|**Networking**|Localtunnel |Serverless sharing via temporary public URLs and connection codes.|
|**AI Orchestration**|LangChainjs DeepAgents|Definition of agent personas, memory, tools, skills, and routing.|
|**Context Integration**|Model Context Protocol (MCP)|Connecting agents to specific knowledge bases (e.g., Microsoft Learn) and local file mapping.|

React+TS+Vite -> greenfield -> priorize modern packages versión
