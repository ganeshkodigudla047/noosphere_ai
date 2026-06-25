export type Vector3Tuple = readonly [x: number, y: number, z: number];

export type KnowledgeNodeKind = "macro" | "micro";

export type KnowledgeNode = {
  id: string;
  documentId: string;
  nodeKind: KnowledgeNodeKind;
  parentId?: string;
  chunkOrder?: number;
  chunkId?: string;
  semanticScore?: number;
  pageNumber: number;
  pageStart?: number;
  pageEnd?: number;
  label: string;
  subject: string;
  summary: string;
  searchText?: string;
  embeddingModel?: string;
  layoutId?: string;
  umapPosition?: Vector3Tuple;
  position: Vector3Tuple;
  color: string;
};

export type FocusedMaterial = {
  node: KnowledgeNode;
  body: readonly string[];
};

export const fixtureNodes: readonly KnowledgeNode[] = [
  {
    id: "cell-membrane",
    documentId: "biology-101",
    nodeKind: "macro",
    pageNumber: 18,
    label: "Cell membrane",
    subject: "Biology",
    summary: "Structure, transport proteins, and membrane permeability.",
    position: [0.63, 0.42, 0.65],
    color: "#8df7c8"
  },
  {
    id: "mitosis",
    documentId: "biology-101",
    nodeKind: "macro",
    pageNumber: 27,
    label: "Mitosis",
    subject: "Biology",
    summary: "The stages and control mechanisms of cell division.",
    position: [0.35, 0.76, 0.55],
    color: "#60dca7"
  },
  {
    id: "newton-laws",
    documentId: "mechanics",
    nodeKind: "macro",
    pageNumber: 9,
    label: "Newton's laws",
    subject: "Physics",
    summary: "Force, inertia, acceleration, and action-reaction pairs.",
    position: [-0.76, 0.32, 0.56],
    color: "#84b9ff"
  },
  {
    id: "eigenvectors",
    documentId: "linear-algebra",
    nodeKind: "macro",
    pageNumber: 42,
    label: "Eigenvectors",
    subject: "Mathematics",
    summary: "Invariant directions under linear transformations.",
    position: [-0.34, -0.71, 0.62],
    color: "#c8a7ff"
  },
  {
    id: "market-equilibrium",
    documentId: "microeconomics",
    nodeKind: "macro",
    pageNumber: 31,
    label: "Market equilibrium",
    subject: "Economics",
    summary: "How supply and demand settle around an equilibrium price.",
    position: [0.6, -0.69, -0.4],
    color: "#ffbd70"
  },
  {
    id: "time-complexity",
    documentId: "algorithms",
    nodeKind: "macro",
    pageNumber: 14,
    label: "Time complexity",
    subject: "Computer Science",
    summary: "Asymptotic analysis and growth rates of algorithms.",
    position: [-0.6, 0.65, -0.46],
    color: "#ff8ea1"
  }
] as const;

export function findNode(query: string): KnowledgeNode | undefined {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return undefined;
  return fixtureNodes.find((node) =>
    `${node.label} ${node.subject} ${node.summary}`
      .toLocaleLowerCase()
      .includes(normalized)
  );
}
