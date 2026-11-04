import type { NextFunction, Request, Response } from 'express';

const ROBOTS = 'User-agent: *\nDisallow: /\n';

// Private backends stay out of search engines: noindex on every response and a blocking /robots.txt
export function noIndex() {
  return (request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');

    if (request.method === 'GET' && request.path === '/robots.txt') {
      response.type('text/plain').send(ROBOTS);

      return;
    }

    next();
  };
}
