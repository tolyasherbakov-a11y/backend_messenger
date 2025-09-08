import type { FastifyInstance } from 'fastify'
export async function registerValidation(app: FastifyInstance) {
app.setValidatorCompiler(({ schema }) => schema as any)
app.setSerializerCompiler(({ schema }) => schema as any)
}