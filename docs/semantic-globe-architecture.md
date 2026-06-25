# Noosphere AI Semantic Globe Architecture

## Data Model

The globe is intentionally hierarchical:

- `documents` owns the uploaded PDF metadata and points to its `macro_node_id`.
- `knowledge_nodes.kind = 'macro'` stores one parent macro-node per document.
- `knowledge_nodes.kind = 'micro'` stores the semantic child chunks for that document and references `parent_node_id`.
- `page_chunks` stores the durable text payload, page range, chunk strategy, and `pgvector` embedding for each child.
- `globe_layouts` versions UMAP runs so a user can rebuild coordinates without rewriting source text.

The active migration in `supabase/migrations/0001_initial_schema.sql` enables `pgvector`, stores `vector(1536)` embeddings for `text-embedding-3-small`, and keeps both raw UMAP coordinates and normalized sphere coordinates:

```sql
sphere = (umap / sqrt(umap_x^2 + umap_y^2 + umap_z^2)) * radius
```

Parent placement is derived, not arbitrary. After children are mapped onto the sphere, the macro-node coordinate is:

```text
parent = normalize(mean(child_sphere_positions)) * radius
```

That makes each document live at the geometric center of its semantic constellation.

## Backend Pipeline

The FastAPI implementation lives in `apps/api/app/pipeline.py`, with the vision OCR preprocessing path in `apps/api/app/ocr.py`.

1. `extract_pdf_pages` reads native PDF text with `pypdf`.
2. Sparse scanned pages route through `NoospherePDFOCR`, which rasterizes at 300 DPI with PyMuPDF, denoises and thresholds with OpenCV, removes horizontal ruled lines, bridges broken vertical strokes, and calls `gpt-4o` with `detail: "high"` for deterministic Markdown OCR.
3. `build_semantic_chunks` creates hybrid page/topic chunks using page boundaries, rough word budgets, chapter-like title detection, and keyword-signature topic shifts.
4. `embed_chunks` sends every child chunk to `text-embedding-3-small`.
5. `reduce_embeddings_to_3d` runs `umap-learn` with cosine distance and `n_components=3`.
6. `normalize_points_to_sphere` projects every UMAP point onto the globe surface.
7. `calculate_parent_coordinate` places the parent at the normalized centroid of its children.
8. `build_supabase_rows` returns rows shaped for `knowledge_nodes` and `page_chunks`.

Run locally:

```powershell
cd apps\api
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
$env:OPENAI_API_KEY = "..."
.\.venv\Scripts\uvicorn app.main:app --reload
```

## Frontend Reveal Model

The web globe implementation lives in `apps/web/src/components/KnowledgeGlobe.tsx`.

Macro-nodes render immediately. Child clusters stay hidden until either:

- the camera approaches the parent node, or
- the user hovers/selects the parent or one of its children.

The reveal strength is calculated every frame because camera distance changes outside React render cycles:

```ts
const proximityReveal = 1 - smoothStep(CHILD_REVEAL_DISTANCE, PARENT_ONLY_DISTANCE, distance);
const targetReveal = isActive ? 1 : proximityReveal;
```

Each child stores an absolute semantic sphere coordinate. The renderer converts it into a local offset from the parent group, then scales and pushes that offset outward during the bloom:

```ts
const localOffset = childTarget.clone().sub(parentPosition);
const clustered = localOffset.clone().multiplyScalar(lerp(0.28, 1, reveal));
const position = clustered.add(normalize(localOffset) * CHILD_BLOOM_DISTANCE * reveal);
```

That keeps the parent/child relationship visually legible at distance while preserving the UMAP-derived constellation when expanded.
