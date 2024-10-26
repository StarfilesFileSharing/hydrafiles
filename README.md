<h1 align="center">Hydrafiles</h1>
<p align="center">The web privacy layer.</p>
<p align="center">
  <a href="#how-do-i-setup-a-node">Skip To Deploy Instructions</a>
  <a href="https://github.com/StarfilesFileSharing/hydrafiles/wiki/Using-Hydrafiles-as-Reverse-Proxy-%E2%80%90-Anonymous-APIs">Host An API Anonymously</a>
  <br><br>
  <img src="/public/favicon.ico">
  <br><br>
  Please submit ideas & feature requests as well as any problems you're facing as an issue.
  <br><br>
  <strong>Like our mission?</strong>
  <br>
  If you're a developer, you can check our issues for ideas on how to help. Otherwise, check <a href="#contribute-to-hydrafiles">here</a> on how else you can contribute.
</p>

## Boostrap Nodes

**We are looking for bootstrap nodes:** Hydrafiles is a new project. To improve availability and reduce downtime, we are looking for additional bootstrap nodes. If you use or plan to use Hydrafiles in production and are running a Hydrafiles
node, send a PR and we'd love to add you as a boostrap node!

- https://hydrafiles.com
- https://hydra.starfiles.co

## What is Hydrafiles?

Hydrafiles is the web privacy layer, enabling anonymous hosting of both files and APIs. Anyone can host and serve static files or backends via HTTP without revealing their identity.

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

## Contribute to Hydrafiles

Because of Hydrafiles' layered approach, it is impossible to prove someone's level of involvement in Hydrafiles. Domain providers may either be hosting their own servers, or pointing to other servers. Server providers may be hosting files,
or may only be mirroring another provider's files.

To ensure resilience, it is crucial to the protocol that servers and domains are evenly distributed between "unfriendly" states. This includes; [China](https://alibabacloud.com), [Russia](https://yandex.cloud),
[America](https://aws.amazon.com/), and [Iran](https://www.arvancloud.ir). As well as politically neutral countries such as [Sweden](https://njal.la). Ensure you aren't violating local laws when deciding on a region/provider.

### Donate a Domain or Subdomain (~$10/y or Free)

#### 1. Get a Domain

If you don't own a domain, you can use [TLD List](https://tld-list.com) to find the sellers with the best price. If you'd like to buy the domain anonymously, use [Njalla](https://njal.la). If you already have a domain, you can use its
subdomain for free.

#### 2. Configure Domain (Set DNS Record)

Once you have a domain or subdomain, find a reliable IP listed on a [popular node](#popular-nodes). Then set the following DNS record, replacing xxxx with the IP:

```
A or AAAA = xxxx
```

#### 3. Use CDN (Optional & Free)

We recommend using a CDN such as [Cloudflare](https://cloudflare.com).

CDNs cache files which makes download times faster and lowers server load. CDNs also add a layer between the Hydrafiles client you use and the public internet, forcing organizations to send requests to the CDN to find the IP.

**If using Cloudflare**, be sure to enable the "Cache Everything" rule.

### Donate Bandwidth (~$10/m+ or Free+Electricity)

#### 1. Get a Server

**Option A: Rent a server**, we recommend [SporeStack](https://sporestack.com) or [Njalla](https://njal.la) as they don't ask for information.

**Option B: Running your own server** requires more maintenance but improves decentralization. To do this, get an old Mac, Windows, or Linux machine, even an RPI.

#### 2. Connect to Hydrafiles

**Option A: Running a Client** improves availability as your client talks to all peers instead of relying on just one. Your client also verifies that files haven't been tampered with before forwarding them.

To run a full node, follow [deploy instructions](#how-do-i-setup-a-node).

**Option B: Running a Reverse Proxy** is cheaper but less safe as file integrity can't be verified. It is not recommended to rely on a reverse-proxied peer as am exit point.

To set up the reverse proxy, first choose a Hydrafiles IP from a [poular node](#popular-nodes). Then configure [Nginx](https://www.digitalocean.com/community/tutorials/how-to-configure-nginx-as-a-reverse-proxy-on-ubuntu-22-04),
[Caddy](https://caddyserver.com/docs/quick-starts/reverse-proxy), or similar software to point port 80 to the IP.

#### 3. Announce Node (Optional)

When your client first starts, it attempts to announce itself to all known peers. A few hours after the client first starts, check other peers to ensure your client is known. If your client isn't known by other peers (or this one), you can
announce your node to a [popular node](#popular-nodes).

### Donate Storage

To donate storage, you must first run a full node (see [Donate Bandwidth](#donate-bandwidth)). This is crucial so storage providers and proxies can't be differentiated.

#### 1. Local Caching (Optional)

When local caching is enabled, your client automatically stores a copy of the most popular files.

In your `config.json` file, set the amount of storage you would like to donate. Whenever this limit is reached, unpopular files will be deleted.

#### 2. S3 Bucket (Optional)

You can optionally configure an S3 bucket with your chosen S3 (compatible) provider.

In your `config.json` file, set your S3 credentials. Ensure your S3 bucket is only accessible by your server for additional privacy.

### I received a takedown notice, what do I do?

Follow the procedure:

1. Remove the file if you are hosting it and aren't legally allowed to host it.
2. Forward the takedown notice to the Hydrafiles operator you received the file from.
3. Respond to the requesting party with the following template:

```
Dear Sir/Madam,

I hope this message finds you well. We are not hosting any files. We are also unsure who is hosting your file(s). We have forwarded your message to related parties, but are unable to investigate any further. For more information, check example.com.

Thanks, your fellow Hydra operator.
```

## How do I setup a node?

### Option A: Run Compiled Binary

1. Go to [Releases](https://github.com/StarfilesFileSharing/hydrafiles/releases) and download the right executable.
2. Run it with `./hydrafiles`.

### Option B: Compile Binary

```bash
git clone https://github.com/StarfilesFileSharing/Hydrafiles
cd Hydrafiles
deno task build
./start
```

### Option C: Build Docker Container

```bash
git clone https://github.com/StarfilesFileSharing/Hydrafiles
cd Hydrafiles
docker build -t hydrafiles .
docker run -p 80:80 hydrafiles
```

### Option D: Run Deno

```bash
git clone https://github.com/StarfilesFileSharing/Hydrafiles
cd Hydrafiles
deno task start
```

**If you intend to run this in production**, run as a service to ensure uptime.

### Configuration

For a list of options and their explanations with instructions on how to use them, check [our Wiki](https://github.com/StarfilesFileSharing/Hydrafiles/wiki/Configuration).
