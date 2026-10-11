FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
# --preload runs wsgi.py once (init_database) before the workers fork
CMD ["gunicorn", "--preload", "--workers", "2", "--bind", "0.0.0.0:8000", "wsgi:app"]
