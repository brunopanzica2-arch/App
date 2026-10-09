FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG NEXT_PUBLIC_MAP_STYLE
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_MAP_STYLE=${NEXT_PUBLIC_MAP_STYLE}
ARG BACKEND_URL=http://api:8000
ENV BACKEND_URL=${BACKEND_URL}
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
