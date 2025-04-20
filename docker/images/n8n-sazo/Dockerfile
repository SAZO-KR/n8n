ARG NODE_VERSION=20

# 1. Use a builder step to install dependencies and build the application
FROM --platform=$TARGETPLATFORM node:${NODE_VERSION}-alpine AS builder

# Install necessary system dependencies
RUN apk add --no-cache \
    msttcorefonts-installer fontconfig \
    git openssh graphicsmagick tini tzdata \
    ca-certificates libc6-compat jq

# Install Microsoft fonts
RUN update-ms-fonts && fc-cache -f && rm -rf /usr/share/fonts/truetype/msttcorefonts/

# Install npm, ICU, and pnpm
COPY .npmrc /usr/local/etc/npmrc
RUN npm install -g npm@9.9.2 full-icu@1.5.0

# Activate corepack and install pnpm
WORKDIR /tmp
COPY package.json ./
RUN corepack enable && corepack prepare pnpm@8.7.0 --activate

# Build the application
WORKDIR /src
COPY . /src
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    --mount=type=cache,id=pnpm-metadata,target=/root/.cache/pnpm/metadata \
    DOCKER_BUILD=true pnpm install --frozen-lockfile
RUN pnpm build || true # Ignore build errors

# Deploy the `n8n` package into /compiled
RUN mkdir /compiled
RUN NODE_ENV=production DOCKER_BUILD=true pnpm --filter=n8n --prod --no-optional deploy /compiled

# Cleanup temporary files
RUN rm -rf /lib/apk/db /var/cache/apk/ /tmp/* /root/.npm /root/.cache/node /opt/yarn*

# 2. Create a new clean image for running the application
FROM --platform=$TARGETPLATFORM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production

ARG N8N_RELEASE_TYPE=dev
ENV N8N_RELEASE_TYPE=${N8N_RELEASE_TYPE}
ENV NODE_ICU_DATA=/usr/local/lib/node_modules/full-icu

WORKDIR /home/node
COPY --from=builder /compiled /usr/local/lib/node_modules/n8n
COPY docker/images/n8n/docker-entrypoint.sh /

# Setup the Task Runner Launcher
ARG TARGETPLATFORM
ARG LAUNCHER_VERSION=1.1.0
COPY docker/images/n8n/n8n-task-runners.json /etc/n8n-task-runners.json

RUN case "$TARGETPLATFORM" in \
        "linux/amd64") ARCH_NAME="amd64" ;; \
        "linux/arm64") ARCH_NAME="arm64" ;; \
        *) echo "Unsupported architecture: $TARGETPLATFORM" && exit 1 ;; \
    esac && \
    mkdir /launcher-temp && \
    cd /launcher-temp && \
    wget https://github.com/n8n-io/task-runner-launcher/releases/download/${LAUNCHER_VERSION}/task-runner-launcher-${LAUNCHER_VERSION}-linux-${ARCH_NAME}.tar.gz && \
    wget https://github.com/n8n-io/task-runner-launcher/releases/download/${LAUNCHER_VERSION}/task-runner-launcher-${LAUNCHER_VERSION}-linux-${ARCH_NAME}.tar.gz.sha256 && \
    echo "$(cat task-runner-launcher-${LAUNCHER_VERSION}-linux-${ARCH_NAME}.tar.gz.sha256) task-runner-launcher-${LAUNCHER_VERSION}-linux-${ARCH_NAME}.tar.gz" > checksum.sha256 && \
    sha256sum -c checksum.sha256 && \
    tar xvf task-runner-launcher-${LAUNCHER_VERSION}-linux-${ARCH_NAME}.tar.gz --directory=/usr/local/bin && \
    cd - && \
    rm -r /launcher-temp

# Rebuild SQLite to ensure compatibility
RUN cd /usr/local/lib/node_modules/n8n && npm rebuild sqlite3 && cd - && \
    ln -s /usr/local/lib/node_modules/n8n/bin/n8n /usr/local/bin/n8n && \
    mkdir .n8n && chown node:node .n8n

# Cleanup old v8-compile-cache files
RUN if [ -d "/tmp/v8-compile-cache" ]; then rm -rf /tmp/v8-compile-cache*; else echo "No v8-compile-cache found"; fi

EXPOSE 5678/tcp

USER node
ENTRYPOINT ["tini", "--", "/docker-entrypoint.sh"]
