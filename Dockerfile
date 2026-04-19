FROM node:20-alpine
WORKDIR /app
COPY package.json index.js ./
ENV PORT=3003
ENV UPSTREAM_URL=http://host.docker.internal:11434
EXPOSE 3003
CMD ["node", "index.js"]
