# ===========================================================================
# vm-extractor — API + daily sync, in one container.
#
# Serves the Sauce Management feed (GET /api/sauce/*) AND runs the nightly
# Vita Mojo scrape when cron-job.org POSTs /api/internal/trigger-daily-sync.
# Both live in one image on purpose: the scrape is a child process of the API
# server (see src/api/daily-sync-runner.js), so they cannot be separated.
#
# The WEEKLY sync is NOT part of this. It stays on GitHub Actions (sync.yml),
# untouched.
#
# Build:  docker build -t vm-extractor .
# Run:    docker run -p 3000:3000 --env-file .env -e PUBLIC_DEPLOY=1 vm-extractor
# ===========================================================================

# The tag MUST match the playwright version in package.json (1.60.0). The image
# ships the exact browser build that version expects, plus every system library
# Chromium needs — installing those by hand on a bare node image is where most
# "works locally, fails in the container" time goes.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

ENV NODE_ENV=production
# Chromium in a container needs a real /tmp and a writable home.
ENV HOME=/home/pwuser

WORKDIR /app

# Copy manifests first so `npm ci` is cached and only re-runs when deps change.
COPY package.json package-lock.json ./

# --omit=dev drops nodemon. Browsers are already in the base image, so tell
# Playwright's postinstall not to download a second copy.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev

COPY . .

# The scrape writes CSVs to downloads/ and screenshots to debug/. Both are
# gitignored so they do not exist in the build context; create them owned by
# the non-root user the base image provides.
RUN mkdir -p downloads debug && chown -R pwuser:pwuser /app

# Never run a browser as root in a container.
USER pwuser

# Informational only — the platform injects its own PORT, which server.js reads.
EXPOSE 3000

CMD ["node", "server.js"]
