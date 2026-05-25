FROM python:3.12-slim

WORKDIR /app

# Install deps first for layer caching. The ortools wheel is large, so this
# step is slow on the first build — expected.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Application code (index.py handler + solver_logic + distance_matrix + server.py).
COPY api/ ./api/

ENV PORT=8000
EXPOSE 8000

CMD ["python", "api/server.py"]
