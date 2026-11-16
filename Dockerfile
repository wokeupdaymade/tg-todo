FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm test

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/todo.sqlite PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
COPY --from=build /app/build ./build
VOLUME /data
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
