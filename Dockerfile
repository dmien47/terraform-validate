FROM node:20-slim

# Install dependencies needed for Terraform
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Terraform
ENV TERRAFORM_VERSION=1.6.6
RUN curl -fsSL https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip \
    -o terraform.zip \
 && unzip terraform.zip \
 && mv terraform /usr/local/bin/terraform \
 && rm terraform.zip

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
