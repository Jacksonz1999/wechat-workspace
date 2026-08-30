# 万用工作台 · 微信服务端镜像（零依赖 Node 服务）
FROM node:20-alpine

WORKDIR /app

# 只拷贝运行必需文件（配置和密钥通过环境变量注入，不进镜像）
COPY server.js ./
COPY lib ./lib

# 数据目录（云平台把持久卷挂到这里，防止重启丢数据）
RUN mkdir -p /app/data
VOLUME /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
