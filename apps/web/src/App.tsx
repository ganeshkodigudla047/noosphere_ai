import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import * as THREE from "three";
import type { KnowledgeNode } from "@noosphere/domain";
import { fixtureNodes } from "@noosphere/domain";
import { ArrowLeft, BookOpen, BrainCircuit, CheckCircle2, FileText, Search, Send, Sparkles, Upload, X } from "lucide-react";
import { KnowledgeGlobe } from "./components/KnowledgeGlobe";
import { PdfReader } from "./components/PdfReader";
import { listMaterials, storeMaterial, updateMaterial, type StoredMaterial } from "./lib/materialStore";
import { extractPdfPages } from "./lib/pdfIndex";

export function App() {
  const [nodes, setNodes] = useState<KnowledgeNode[]>([...fixtureNodes]);
  const [selected, setSelected] = useState<KnowledgeNode>();
  const [focusedNode, setFocusedNode] = useState<KnowledgeNode>();
  const [query, setQuery] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | undefined>();
  const [uploadNotice, setUploadNotice] = useState<UploadNotice>();
  const [materialUrls, setMaterialUrls] = useState<Record<string, string>>({});
  const [materialPages, setMaterialPages] = useState<Record<string, StoredMaterial["pages"]>>({});
  const [orbitEnabled, setOrbitEnabled] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const focusTimer = useRef<number | undefined>(undefined);
  const result = useMemo(() => findNode(nodes, query), [nodes, query]);

  const focusAndOpen = useCallback((node: KnowledgeNode) => {
    window.clearTimeout(focusTimer.current);
    setFocusedNode(node);
    focusTimer.current = window.setTimeout(() => {
      setSelected(node);
      setFocusedNode(undefined);
    }, 1350);
  }, []);

  const sendPageQuestion = useCallback(async (question: string) => {
    if (!selected) return;
    const trimmed = question.trim();
    if (!trimmed) return;

    // Build full content from actual stored pages for this chunk's page range
    const pages = materialPages[selected.documentId] ?? [];
    const pageStart = selected.pageStart ?? selected.pageNumber ?? 1;
    const pageEnd = selected.pageEnd ?? pageStart;
    const fullContent = pages
      .filter((p) => p.pageNumber >= pageStart && p.pageNumber <= pageEnd)
      .map((p) => p.text)
      .join("\n\n")
      .trim() || selected.summary;

    setChatError(undefined);
    setChatLoading(true);
    setChatInput("");

    // Add user message + empty assistant placeholder
    setChatMessages((prev) => [
      ...prev,
      { role: "user", text: trimmed },
      { role: "assistant", text: "" },
    ]);

    try {
      const response = await fetch("http://127.0.0.1:8000/chat/page/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document_id: selected.documentId ?? "unknown",
          node_id: selected.id,
          topic: selected.label,
          summary: selected.summary,
          content: fullContent,
          question: trimmed,
        }),
      });

      if (!response.ok || !response.body) {
        const body = await response.text();
        throw new Error(body || `HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process all complete SSE messages (split on double newline)
        const parts = buffer.split("\n\n");
        // Keep the last incomplete part in the buffer
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;

          // slice "data:" then remove only a single leading space (preserve internal spaces)
          const raw = line.slice(5);
          const token = raw.startsWith(" ") ? raw.slice(1) : raw;
          if (token === "[DONE]") break;
          if (token.startsWith("[ERROR]")) {
            throw new Error(token.slice(7).trim());
          }
          if (!token) continue;

          // Append token to the last assistant message
          setChatMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
              updated[updated.length - 1] = { role: "assistant", text: last.text + token };
            }
            return updated;
          });
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unable to get an answer right now.";
      setChatError(msg);
      // Remove the empty assistant placeholder on error
      setChatMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant" && last.text === "") {
          updated.pop();
        }
        return updated;
      });
    } finally {
      setChatLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    setChatMessages([]);
    setChatInput("");
    setChatError(undefined);
    setChatLoading(false);
  }, [selected?.id]);

  useEffect(() => {
    let active = true;
    void listMaterials().then(async (materials) => {
      if (!active || materials.length === 0) return;
      const indexedMaterials: StoredMaterial[] = [];
      for (const material of materials) {
        if (material.pages?.length && material.ocrCompleted) {
          indexedMaterials.push(material);
          continue;
        }
        const pages = await extractPdfPages(material.file, (status) => {
          if (active) setUploadNotice({ kind: "working", message: progressMessage(material.name, status) });
        });
        const indexed = { ...material, pages, ocrCompleted: true };
        await updateMaterial(indexed);
        indexedMaterials.push(indexed);
      }
      if (!active) return;
      const restoredNodes = indexedMaterials.flatMap((material, index) => materialNodes(material, fixtureNodes.length + index));
      setNodes((current) => [...current.filter((node) => !materials.some((material) => material.id === node.documentId)), ...restoredNodes]);
      setMaterialUrls(Object.fromEntries(indexedMaterials.map((material) => [material.id, URL.createObjectURL(material.file)])));
      setMaterialPages(Object.fromEntries(indexedMaterials.map((material) => [material.id, material.pages])));
    }).catch(() => {
      if (active) setUploadNotice({ kind: "error", message: "Saved PDFs could not be restored in this browser." });
    });
    return () => {
      active = false;
      window.clearTimeout(focusTimer.current);
    };
  }, []);

  const handleMaterial = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setUploadNotice({ kind: "error", message: "Choose a PDF file." });
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setUploadNotice({ kind: "error", message: "PDFs must be smaller than 50 MB." });
      return;
    }

    setUploadNotice({ kind: "working", message: `Extracting searchable text from ${file.name}…` });
    try {
      const pages = await extractPdfPages(file, (status) => {
        setUploadNotice({ kind: "working", message: progressMessage(file.name, status) });
      });
      const material = await storeMaterial(file, pages);
      const newNodes = materialNodes(material, nodes.length);
      const metaNode = newNodes.find((node) => node.nodeKind === "macro") ?? newNodes[0];
      setNodes((current) => [...current, ...newNodes]);
      setMaterialUrls((current) => ({ ...current, [material.id]: URL.createObjectURL(material.file) }));
      setMaterialPages((current) => ({ ...current, [material.id]: pages }));
      const searchablePages = pages.filter((page) => page.text.length > 0).length;
      setUploadNotice({
        kind: "ready",
        message: searchablePages
          ? `${pages.length} pages added; ${searchablePages} pages are content-searchable.`
          : `${pages.length} pages added, but no selectable text was found. This PDF needs OCR.`,
        node: metaNode
      });
    } catch (error) {
      const message = error instanceof DOMException && error.name === "QuotaExceededError"
        ? "This browser does not have enough storage space for that PDF."
        : "The PDF could not be saved. Check browser storage permissions and try again.";
      setUploadNotice({ kind: "error", message });
    }
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (result) focusAndOpen(result);
  };

  if (selected) {
    const materialUrl = materialUrls[selected.documentId];
    return (
      <main className="focus-layout">
        <aside className="orientation-panel">
          <button className="back-button" onClick={() => { setSelected(undefined); setFocusedNode(undefined); }}><ArrowLeft size={17} /> Back to globe</button>
          <div className="mini-globe"><KnowledgeGlobe nodes={nodes} selected={selected} onSelect={setSelected} compact orbitEnabled={orbitEnabled} /></div>
          <div className="location-card">
            <span>{selected.subject}</span><strong>{selected.label}</strong><small>Page {selected.pageNumber}</small>
          </div>
        </aside>

        <article className="document-panel">
          <div className="document-kicker"><BookOpen size={15} /> {selected.subject} · Page {selected.pageNumber}</div>
          <h1>{selected.label}</h1>
          <p className="lead">{selected.summary}</p>
          {materialUrl ? (
            <PdfReader source={materialUrl} title={selected.label} initialPage={selected.pageNumber} />
          ) : <div className="placeholder-copy">
            <p>This focused reading view is wired to the selected globe node. Extracted document content will replace this fixture in the ingestion phase.</p>
            <h2>Core idea</h2>
            <p>Every point on the knowledge globe represents a page or topic. Related ideas occupy nearby positions, making the shape of a student’s learning material visible and explorable.</p>
            <h2>Why spatial context helps</h2>
            <p>The mini-globe preserves orientation while reading. Returning to the full globe keeps the same conceptual neighborhood in view.</p>
          </div>}
        </article>

        <button className="mobile-chat-trigger" onClick={() => setChatOpen(true)}><Sparkles size={18} /> Ask about this page</button>
        <ChatPanel
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          topic={selected.label}
          input={chatInput}
          onInputChange={setChatInput}
          messages={chatMessages}
          onSend={sendPageQuestion}
          loading={chatLoading}
          error={chatError}
          onInputFocus={() => setOrbitEnabled(false)}
          onInputBlur={() => setOrbitEnabled(true)}
        />
      </main>
    );
  }

  return (
    <main className="globe-page">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Noosphere home"><span className="brand-mark"><BrainCircuit size={20} /></span>noosphere</a>
        <div className="top-actions">
          <input ref={fileInput} className="visually-hidden" type="file" accept="application/pdf,.pdf" onChange={handleMaterial} />
          <button className="ghost-button" onClick={() => fileInput.current?.click()}><Upload size={16} /> Upload material</button>
          <button className="avatar" aria-label="Account">AS</button>
        </div>
      </header>

      <section className="hero-copy">
        <p className="eyebrow">Your learning universe</p>
        <h1>See how everything<br />you learn connects.</h1>
        <p>Explore your notes as a living map of ideas. Search a concept or drift through the constellations.</p>
      </section>

      <form className="search-bar" onSubmit={submitSearch}>
        <Search size={20} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a topic, page, or idea…" aria-label="Search knowledge" />
        <kbd>↵</kbd>
        {query && result && <div className="search-hint search-match"><strong>{result.label}</strong><span>Press Enter to fly to this node</span></div>}
        {query && !result && <div className="search-hint">No match yet. Try “mitosis”, “Newton”, “complexity”, or an uploaded filename.</div>}
      </form>

      <div className={`globe-stage ${focusedNode ? "is-focusing" : ""}`}><KnowledgeGlobe nodes={nodes} selected={focusedNode} onSelect={focusAndOpen} /></div>
      <div className="globe-legend"><span /> Drag to explore · Click a node to focus</div>
      {uploadNotice && <UploadToast notice={uploadNotice} onClose={() => setUploadNotice(undefined)} onOpen={(node) => setSelected(node)} />}
    </main>
  );
}

type UploadNotice = {
  kind: "working" | "ready" | "error";
  message: string;
  node?: KnowledgeNode;
};

function UploadToast({ notice, onClose, onOpen }: { notice: UploadNotice; onClose: () => void; onOpen: (node: KnowledgeNode) => void }) {
  return <div className={`upload-toast ${notice.kind}`} role="status">
    <span className="upload-icon">{notice.kind === "ready" ? <CheckCircle2 size={20} /> : <FileText size={20} />}</span>
    <div><strong>{notice.kind === "working" ? "Reading material" : notice.kind === "ready" ? "Material ready" : "Upload blocked"}</strong><small>{notice.message}</small></div>
    {notice.node && <button className="open-material" onClick={() => onOpen(notice.node!)}>Open</button>}
    <button className="close-toast" onClick={onClose} aria-label="Dismiss"><X size={16} /></button>
  </div>;
}

function findNode(nodes: readonly KnowledgeNode[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return undefined;
  return nodes.find((node) => `${node.label} ${node.subject} ${node.summary} ${node.searchText ?? ""}`.toLocaleLowerCase().includes(normalized));
}

function progressMessage(filename: string, status: { phase: "extracting" | "ocr"; page: number; pageCount: number; progress?: number }) {
  if (status.phase === "ocr") {
    const percentage = Math.round((status.progress ?? 0) * 100);
    return `OCR ${filename}: page ${status.page}/${status.pageCount} · ${percentage}%`;
  }
  return `Indexing ${filename}: page ${status.page}/${status.pageCount}`;
}

function materialNodes(material: StoredMaterial, startIndex: number): KnowledgeNode[] {
  const documentTitle = material.name.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ");
  const pages = material.pages?.length ? material.pages : [{ pageNumber: 1, title: documentTitle, text: "" }];
  const chunks = buildSemanticChunks(pages, documentTitle);
  const childPositions = chunks.map((chunk, index) => semanticFallbackPosition(chunk.content || chunk.title, startIndex, index, chunks.length));
  const parentPosition = childPositions
    .reduce((center, position) => center.add(new THREE.Vector3(...position)), new THREE.Vector3())
    .normalize()
    .toArray() as [number, number, number];

  const macroNode: KnowledgeNode = {
    id: `material-${material.id}-macro`,
    documentId: material.id,
    nodeKind: "macro",
    pageNumber: chunks[0]?.pageStart ?? 1,
    pageStart: chunks[0]?.pageStart ?? 1,
    pageEnd: chunks.at(-1)?.pageEnd ?? pages.length,
    label: documentTitle,
    subject: "Uploaded material",
    summary: material.pages?.length
      ? `${chunks.length} semantic chunk${chunks.length === 1 ? "" : "s"} from ${material.pages.length} page${material.pages.length === 1 ? "" : "s"}`
      : documentTitle,
    position: parentPosition,
    color: "#febf6b"
  };

  const childNodes = chunks.map((chunk, chunkIndex) => {
    const snippet = chunk.content.slice(0, 220).trim();
    const position = childPositions[chunkIndex] ?? parentPosition;
    return {
      id: `material-${material.id}-chunk-${chunkIndex}`,
      documentId: material.id,
      nodeKind: "micro",
      parentId: macroNode.id,
      chunkOrder: chunkIndex,
      pageNumber: chunk.pageStart,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      label: chunk.title,
      subject: "Uploaded material",
      summary: snippet || `${documentTitle}, pages ${chunk.pageStart}-${chunk.pageEnd}`,
      searchText: `${documentTitle} ${chunk.content}`,
      position,
      color: "#ffe08a"
    } satisfies KnowledgeNode;
  });

  return [macroNode, ...childNodes];
}

type LocalSemanticChunk = {
  pageStart: number;
  pageEnd: number;
  title: string;
  content: string;
};

function buildSemanticChunks(pages: StoredMaterial["pages"], documentTitle: string): LocalSemanticChunk[] {
  const chunks: LocalSemanticChunk[] = [];
  let active: LocalSemanticChunk | undefined;
  let previousSignature = new Set<string>();

  for (const page of pages ?? []) {
    const content = page.text.trim();
    const signature = keywordSignature(content);
    const wordCount = active?.content.split(/\s+/).filter(Boolean).length ?? 0;
    const similarity = jaccard(previousSignature, signature);
    const beginsNewTopic = active && (wordCount > 850 || (previousSignature.size > 0 && signature.size > 0 && similarity < 0.16));

    if (!active || beginsNewTopic) {
      active = {
        pageStart: page.pageNumber,
        pageEnd: page.pageNumber,
        title: page.title || `${documentTitle} page ${page.pageNumber}`,
        content
      };
      chunks.push(active);
    } else {
      active.pageEnd = page.pageNumber;
      active.content = `${active.content} ${content}`.trim();
    }

    previousSignature = signature;
  }

  return chunks.length ? chunks : [{ pageStart: 1, pageEnd: 1, title: documentTitle, content: "" }];
}

function keywordSignature(text: string) {
  const stopWords = new Set(["about", "after", "also", "because", "before", "being", "between", "could", "from", "have", "into", "more", "that", "their", "there", "these", "this", "through", "with", "would"]);
  return new Set(
    text.toLocaleLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 4 && !stopWords.has(word))
      .slice(0, 36)
  );
}

function jaccard(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  left.forEach((word) => {
    if (right.has(word)) intersection += 1;
  });
  return intersection / (left.size + right.size - intersection);
}

function semanticFallbackPosition(text: string, documentIndex: number, chunkIndex: number, chunkCount: number): [number, number, number] {
  const hash = Array.from(text || `${documentIndex}-${chunkIndex}`).reduce((value, char) => {
    return Math.imul(value ^ char.charCodeAt(0), 16777619);
  }, 2166136261);
  const localAngle = (chunkIndex / Math.max(1, chunkCount)) * Math.PI * 2;
  const documentAngle = documentIndex * 0.61 + (hash % 97) * 0.002;
  const base = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), documentAngle);
  const tangentA = new THREE.Vector3().crossVectors(base, new THREE.Vector3(0, 1, 0)).normalize();
  const tangentB = new THREE.Vector3().crossVectors(base, tangentA).normalize();
  return base
    .add(tangentA.multiplyScalar(Math.cos(localAngle) * 0.18))
    .add(tangentB.multiplyScalar(Math.sin(localAngle) * 0.18))
    .normalize()
    .multiplyScalar(1.04)
    .toArray() as [number, number, number];
}

function ChatPanel({
  open,
  onClose,
  topic,
  input,
  onInputChange,
  messages,
  onSend,
  loading,
  error,
  onInputFocus,
  onInputBlur,
}: {
  open: boolean;
  onClose: () => void;
  topic: string;
  input: string;
  onInputChange: (value: string) => void;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  onSend: (question: string) => void;
  loading: boolean;
  error?: string;
  onInputFocus?: () => void;
  onInputBlur?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom whenever messages update (like ChatGPT)
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <aside className={`chat-panel ${open ? "is-open" : ""}`}>
      <button className="sheet-handle" onClick={onClose} aria-label="Close chat" />
      <div className="chat-heading">
        <span><Sparkles size={18} /></span>
        <div><strong>Page companion</strong><small>Grounded in this page</small></div>
      </div>

      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <BrainCircuit size={28} />
            <strong>Curious about {topic}?</strong>
            <p>Ask anything about this page. Answers are grounded only in this content.</p>
          </div>
        ) : (
          messages.map((message, index) => {
            const isLastAssistant = message.role === "assistant" && index === messages.length - 1;
            const isStreaming = isLastAssistant && loading;
            return (
              <div key={index} className={`chat-bubble chat-bubble-${message.role}`}>
                {message.role === "assistant" && (
                  <div className="chat-bubble-label"><Sparkles size={11} /> Page companion</div>
                )}
                <p>
                  {message.text || (isStreaming ? "" : "…")}
                  {isStreaming && <span className="chat-cursor" />}
                </p>
              </div>
            );
          })
        )}
        {error && <div className="chat-error"><strong>Error:</strong> {error}</div>}
        <div ref={messagesEndRef} />
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => { e.preventDefault(); if (!loading) onSend(input); }}
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!loading && input.trim()) onSend(input);
            }
          }}
          placeholder="Ask about this page…"
          disabled={loading}
          aria-label="Chat question"
          autoComplete="off"
        />
        <button type="submit" aria-label="Send" disabled={loading || !input.trim()}>
          {loading ? <span className="chat-spinner" /> : <Send size={16} />}
        </button>
      </form>
    </aside>
  );
}
