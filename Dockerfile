FROM node:18
WORKDIR /app
COPY . .
RUN deno install --allow-scripts=npm:utp-native@2.5.3,npm:node-datachannel@0.10.1,npm:bufferutil@4.0.8,npm:utf-8-validate@6.0.4,npm:base64@2.1.0
RUN build
EXPOSE 80
CMD ["deno", "task", "start"]
