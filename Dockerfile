FROM node:24
WORKDIR /app
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg && \
    # Install yt-dlp directly from github to get the absolute latest version
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp
COPY package.json ./
RUN npm install
COPY tsconfig.json .env ./
COPY ./assets ./assets
COPY ./src ./src
RUN npm run build
CMD ["npm", "start"]