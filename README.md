# Noosphere AI

Cross-platform spatial study workspace for web and Expo mobile.

## What exists

- Interactive React Three Fiber knowledge globe on web
- Search-to-node focus flow and smooth camera interpolation
- Desktop mini-globe, document, and page-chat layout
- Responsive mobile web bottom sheet
- Expo-native home, reader, and gesture-driven chat sheet
- Shared fixture domain models
- Supabase schema for isolated documents, pages, embeddings, layouts, jobs, and chats
- RLS and private, per-user PDF storage policies

## Run locally

Requirements: Node.js 20.19 or newer.

```powershell
npm.cmd install
npm.cmd run dev:web
```

Open the Vite URL printed in the terminal. Search for `mitosis`, `Newton`, or `complexity`, or click a globe node.

For Expo:

```powershell
npm.cmd run dev:mobile
```

For the FastAPI ingestion/OCR service:

```powershell
cd apps\api
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
$env:OPENAI_API_KEY = "..."
.\.venv\Scripts\uvicorn app.main:app --reload
```

The PDF ingestion endpoint is `POST /ingest/pdf`. It runs native PDF text extraction first, then uses the high-resolution PyMuPDF/OpenCV/OpenAI vision OCR path for sparse scanned pages by default. Send `ocr_all_pages=true` to force OCR for every page. The direct OCR test endpoint is `POST /ocr/pdf` with optional `page_numbers` such as `1,3-5`.

## Configuration

Copy `.env.example` to `.env.local` and add the public project URL and anonymous key. Service-role and OpenAI keys belong only in trusted backend environments.

Apply `supabase/migrations/0001_initial_schema.sql` through the Supabase CLI or SQL migration workflow after creating a project and enabling Google authentication.

## Next vertical slice

Connect Supabase clients and Google OAuth, replace fixtures with an authenticated node query, then implement signed PDF uploads and the asynchronous ingestion worker.

## Semantic globe architecture

The parent/child node schema, UMAP mapping pipeline, and React Three Fiber proximity reveal model are documented in `docs/semantic-globe-architecture.md`. The FastAPI ingestion skeleton lives in `apps/api`.
