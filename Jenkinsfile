pipeline {
    tools {
        git "Default"
    }
    agent {
        label "stargaze-builder"
    }
    environment {
        ENV_FILE=credentials("verdale-core-service-prod")
    }
    stages {
        stage("Checkout") {
            steps {
                echo "🏷️ Checking out branch: main"
                checkout([
                    $class: 'GitSCM',
                    branches: [[name: '*/main']],
                    userRemoteConfigs: scm.userRemoteConfigs
                ])
            }
        }
        stage("Setup Environment") {
            steps {
                echo "⚙️ Creating environment file with credentials..."
                sh 'cp $ENV_FILE .env'
            }
        }
        stage("Build and Run Container") {
            steps {
                echo "🐳 Building and starting Docker container..."
                sh '''
                export BUILD_VERSION=$(git rev-parse --short=12 HEAD)
                docker compose -f docker-compose.deploy.yml up -d --build || docker-compose -f docker-compose.deploy.yml up -d --build
                '''
            }
        }
        // stage("Migrate Database") {
        //     steps {
        //         echo "🔼 Waiting for app container to be ready..."
        //         sh '''
        //         for i in $(seq 1 30); do
        //             if docker compose -f docker-compose.deploy.yml ps app --format "{{.Status}}" 2>/dev/null | grep -q "Up" || docker-compose -f docker-compose.deploy.yml ps app 2>/dev/null | grep -q "Up"; then
        //                 echo "✅ App container is running"
        //                 break
        //             fi
        //             sleep 1
        //         done
        //         '''
        //         echo "🔼 Running Prisma migrations..."
        //         sh 'docker compose -f docker-compose.deploy.yml exec -T app npx prisma migrate deploy || docker-compose -f docker-compose.deploy.yml exec -T app npx prisma migrate deploy'
        //     }
        // }
    }
    post {
        success {
            echo "🎉 Deployment successful!"
        }
        failure {
            echo "🚨 Deployment failed!"
        }
    }
}
