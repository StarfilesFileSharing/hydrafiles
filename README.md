<h1 align="center">Hydrafiles</h1>
<p align="center">The (P2P) web privacy layer.</p>
<p align="center">
  <a href="https://github.com/StarfilesFileSharing/hydrafiles/releases">Quick Install</a>
  <br><br>
  <img src="./public/favicon.ico">
  <br><br>
  Please submit ideas & feature requests as well as any problems you're facing as an issue.
  <br><br>
  <strong>Like our mission?</strong>
  <br>
  If you're a developer, you can check our issues for ideas on how to help. Otherwise, check <a href="#contribute-to-hydrafiles">here</a> on how else you can contribute.
</p>

**Reading this on GitHub?** Check our docs at any Hydrafiles node such as [hydrafiles.com](https://hydrafiles.com).

## What is Hydrafiles?

Hydrafiles is a peer to peer network, enabling anonymous upload/download of files and anonymous hosting and usage of APIs. Peers can host and serve static files or dynamic backends over HTTP and/or WebRTC without revealing their identity.

## What environments does Hydrafiles run in?

Hydrafiles runs in both browsers and desktop/server with both an JS library available for both, and an executable or Docker container available for non-web environments.

P.s. **Using web nodes**, you are able to **serve APIs** and static files over WebRTC, that are **accessible via HTTP**. Yes, you read that right.

## How is it anonymous?

![I'm Spartacus!](public/i-am-spartacus.gif)

TLDR: This scene ^

Hydrafiles uses Spartacus Routing. Spartacus Routing routing involves a gossip network where all peers act as one, where no matter which peer you call, you will receive the same response.

When someone requests a file or calls an endpoint, the request is sent to all peers. If a peer has the file or controls the requested endpoint, it will serve it. If not, it will forward the request to known peers and mirror the response. If
no one has the file or controls the endpoint, the request will return a 404 once peers timeout. Because the request is forwarded by each peer and all peers mirror the response, it is impossible to tell which peers the request or response
originated from.

## Who's in charge of Hydrafiles?

No one, anyone, everyone. Hydrafiles doesn't have a head. It's simply an API specification. Anyone can setup a domain, server, S3 bucket, or literally just run a JavaScript library and connect to the network. The more people that decide to
do this, the more private the network.

## Where is Hydrafiles?

Hydrafiles is everywhere. With the goal of being cross-border, we ask people like you to contribute to the movement, by setting up cross-border domains and servers.

## What Hydrafiles isn't.

Hydrafiles does **not** hide content. All data on the Hydrafiles network can be seen by all peers. Sensitive content MUST be encrypted before submission to the network.
