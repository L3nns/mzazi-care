FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

# Model weights are cached into the image so the container does not download
# them on every start.
ENV HF_HOME=/app/.cache/huggingface SENTENCE_TRANSFORMERS_HOME=/app/.cache/st

COPY requirements.txt .
# CPU-only PyTorch first: the default wheel on Linux bundles CUDA (several GB)
# that this service never uses. sentence-transformers then reuses it.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r requirements.txt

ARG PREFETCH_MODEL=all-MiniLM-L6-v2
ENV PREFETCH_MODEL=${PREFETCH_MODEL}
COPY prefetch_model.py .
RUN python prefetch_model.py

COPY . .
RUN mkdir -p /app/model

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health').status==200 else 1)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
