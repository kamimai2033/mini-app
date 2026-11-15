FROM python:3.13-slim
WORKDIR /app
COPY news_api.py /app/news_api.py
RUN mkdir /data && chown 10001:10001 /data
USER 10001:10001
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8010
CMD ["python", "news_api.py"]
