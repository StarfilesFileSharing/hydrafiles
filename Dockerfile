FROM node:18
WORKDIR /app
COPY . .
RUN build
EXPOSE 80
CMD ["deno", "task", "start"]
