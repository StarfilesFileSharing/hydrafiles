<h1 align="center">Hydrafiles</h1>
<p align="center">The web privacy layer.</p>
<p align="center">
  <img src="./public/favicon.ico">
  <br><br>
  Please submit ideas & feature requests as well as any problems you're facing as an issue.
  <br><br>
  <strong>Like our mission?</strong>
  <br>
  If you're a developer, you can check our issues for ideas on how to help. Otherwise, check <a href="#contribute-to-hydrafiles">here</a> on how else you can contribute.
</p>

## What is Hydrafiles?

Hydrafiles is the web privacy layer, enabling anonymous hosting of both files and APIs. Anyone can host and serve static files or backends over HTTP and/or WebRTC without revealing their identity.

## Why Hydrafiles?

In a world where information is freedom. We believe that the people have a right to access the world's information. We believe the people of Russia, China, Iran, America, North Korea, and the rest of the world, all deserve access to the
same information. Most people don't use anti-censorship tools when they're inconvenient. We can't control the people. I personally wish the whole internet ran on I2P. But that's never going to happen because it's slow and inconvenient for
users. Torrents died off because streaming is more convenient. Piracy is back because subscriptions have gotten inconvenient. Hydrafiles realises that the people don't want to trade their convenience for freedom. Unfortunately, not all
hosts have the luxury. With global censorship of whistleblowing and propaganda at an all time high, it is, now more than ever, crucial for people to be able to anonymously serve files to the masses.

## How does it work?

![I'm Spartacus!](public/i-am-spartacus.gif)

TLDR: This scene ^

When someone requests a file or calls an endpoint, the request is sent to all peers. If a peer has the file or controls the requested endpoint, it will serve it. If not, it will forward the request to known peers and mirror the response.
Because the request is forwarded by each peer and all peers mirror the response, it is impossible to tell which peer the response originated from. If no one has the file or controls the endpoint, the request will return a 404 once peers
timeout.

## What Hydrafiles isn't.

The Hydrafiles network does NOT provide privacy to the end user. Hydrafiles is designed to provide hosts privacy, not users. The peer you initially connect to can see exactly what you're doing. If you need to do something discretely, use
TOR when accessing Hydrafiles. Hydrafiles itself does not hide content. All data on the Hydrafiles network can be seen by all peers. Sensitive content MUST be encrypted before submission to the network.

## Who's in charge of Hydrafiles?

No one, anyone, everyone. Hydrafiles doesn't have a head. It's simply an API specification. Anyone can setup a domain, server, or S3 bucket, and add it to the network. The more people that decide to do this, the stronger the network.

## How does Hydrafiles obscure where something is being hosted?

When you call a Hydrafiles peer, if it's not hosting the requested content, it will check with other peers and pull the content from them. This means no matter which peer you ask, as long as one is serving the content, they all are.

## Where is Hydrafiles?

Hydrafiles is everywhere. With the goal of being cross-border, we ask people like you to contribute to the movement, by setting up cross-border domains and servers.
