FROM node:22.20.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:22.20.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save prisma@7.2.0
COPY --from=build /app/build ./build
COPY --from=build /app/generated ./generated
COPY prisma ./prisma
COPY prisma.config.ts ./
# Local file storage (STORAGE_DRIVER=local) writes here; owned by the app user.
RUN mkdir -p /data/storage && chown -R node:node /data
EXPOSE 8080
USER node
# Run `npx prisma migrate deploy` (with DIRECT_DATABASE_URL) as a release
# step before starting new containers.
CMD ["node", "build/src/index.js"]
