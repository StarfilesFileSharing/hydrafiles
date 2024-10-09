FROM node:18
WORKDIR /app
COPY . .
RUN yarn
EXPOSE 80
CMD ["yarn", "start"]
