FROM oven/bun:1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN bun install

COPY . .

RUN bun run build
RUN bunx playwright install --with-deps chromium

ENV NODE_ENV=production

CMD ["bun", "run", "telegram:bot"]
