import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common'
import { Observable } from 'rxjs'
import { v4 as uuidv4 } from 'uuid'
import { Request, Response } from 'express'
import { requestContext } from '../../lib/logger'

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest<Request>()
    const res = context.switchToHttp().getResponse<Response>()

    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4()
    res.setHeader('x-correlation-id', correlationId)

    return new Observable((subscriber) => {
      requestContext.run({ correlationId }, () => {
        next.handle().subscribe({
          next: (val) => subscriber.next(val),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        })
      })
    })
  }
}
