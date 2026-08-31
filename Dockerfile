# Image de base commune à toutes les étapes. Par défaut on suit `node:24-alpine`
# (patchs de sécurité repris à chaque rebuild) ; le workflow de release peut
# passer --build-arg NODE_IMAGE=node:24-alpine@sha256:... pour figer un digest.
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS development-dependencies-env
COPY . /app
WORKDIR /app
RUN npm ci

FROM ${NODE_IMAGE} AS production-dependencies-env
COPY ./package.json package-lock.json /app/
WORKDIR /app
RUN npm ci --omit=dev

FROM ${NODE_IMAGE} AS build-env
COPY . /app/
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
WORKDIR /app
RUN npm run build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
COPY ./package.json package-lock.json /app/
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/dist /app/dist
WORKDIR /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
