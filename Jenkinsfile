// Verdale core service: check (lint, typecheck, tests against real Postgres),
// migrations dry-run, then build and push the Docker image.
//
// Agent requirements: Docker + Docker Pipeline plugin.
// Credentials: `registry-credentials` (username/password for REGISTRY).

pipeline {
  agent any

  options {
    timestamps()
    timeout(time: 30, unit: 'MINUTES')
    disableConcurrentBuilds(abortPrevious: true)
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  parameters {
    string(name: 'REGISTRY', defaultValue: 'registry.example.com', description: 'Docker registry host')
    string(name: 'IMAGE_NAME', defaultValue: 'verdale/core-service', description: 'Image repository')
    string(name: 'REGISTRY_CREDENTIALS_ID', defaultValue: 'registry-credentials', description: 'Jenkins credentials ID for the registry')
    string(name: 'PUSH_BRANCH', defaultValue: 'main', description: 'Only this branch pushes images')
  }

  environment {
    NODE_IMAGE = 'node:22.20.0-bookworm'
    POSTGRES_IMAGE = 'postgres:17-alpine'
    DATABASE_URL = 'postgresql://postgres:ci@database:5432/verdale'
    IMAGE_TAG = "${env.GIT_COMMIT?.take(12) ?: env.BUILD_NUMBER}"
  }

  stages {
    stage('Check') {
      steps {
        script {
          docker.image(env.POSTGRES_IMAGE).withRun('-e POSTGRES_PASSWORD=ci -e POSTGRES_DB=verdale') { database ->
            docker.image(env.NODE_IMAGE).inside("--link ${database.id}:database -e HOME=${env.WORKSPACE}") {
              withEnv(["DIRECT_DATABASE_URL=${env.DATABASE_URL}", "TEST_DATABASE_URL=${env.DATABASE_URL}"]) {
                sh '''
                  until (echo > /dev/tcp/database/5432) 2>/dev/null; do sleep 1; done
                  npm ci
                  npx prisma generate
                  npx prisma migrate deploy
                  npm run check
                '''
              }
            }
          }
        }
      }
    }

    stage('Migrations') {
      // Every migration must apply cleanly to an empty database.
      steps {
        script {
          docker.image(env.POSTGRES_IMAGE).withRun('-e POSTGRES_PASSWORD=ci -e POSTGRES_DB=verdale') { database ->
            docker.image(env.NODE_IMAGE).inside("--link ${database.id}:database -e HOME=${env.WORKSPACE}") {
              withEnv(["DIRECT_DATABASE_URL=${env.DATABASE_URL}"]) {
                sh '''
                  until (echo > /dev/tcp/database/5432) 2>/dev/null; do sleep 1; done
                  npm ci
                  npx prisma migrate deploy
                  npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
                  npx prisma db seed
                '''
              }
            }
          }
        }
      }
    }

    stage('Build image') {
      steps {
        sh 'docker build -t "${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}" .'
      }
    }

    stage('Push image') {
      when { branch params.PUSH_BRANCH }
      steps {
        withCredentials([usernamePassword(credentialsId: params.REGISTRY_CREDENTIALS_ID, usernameVariable: 'REGISTRY_USER', passwordVariable: 'REGISTRY_PASSWORD')]) {
          sh '''
            echo "$REGISTRY_PASSWORD" | docker login "$REGISTRY" -u "$REGISTRY_USER" --password-stdin
            docker push "${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
            docker tag "${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}" "${REGISTRY}/${IMAGE_NAME}:latest"
            docker push "${REGISTRY}/${IMAGE_NAME}:latest"
            docker logout "$REGISTRY"
          '''
        }
      }
    }
  }

  post {
    always {
      sh 'docker image rm -f "${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}" "${REGISTRY}/${IMAGE_NAME}:latest" || true'
      cleanWs()
    }
  }
}
