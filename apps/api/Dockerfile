FROM python:3.11-slim-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libgl1 \
    libgomp1 \
    libsm6 \
    libxext6 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
ENV PORT=8000

CMD ["python", "-c", "import os,subprocess,sys; subprocess.run(['uvicorn','app.main:app','--host','0.0.0.0','--port',os.environ.get('PORT','8000')], check=True)"]
