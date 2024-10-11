FROM node:18
WORKDIR /app
COPY . .
RUN yarn
RUN build
EXPOSE 80
CMD ["yarn", "start"]
