FROM node:20-alpine

# Install ffmpeg
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

ENV NODE_ENV=production

EXPOSE 3000

ENV NIXPACKS_NGINX_CLIENT_MAX_BODY_SIZE=200m

CMD ["npm", "start"]