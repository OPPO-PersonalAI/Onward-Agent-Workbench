<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deep Learning Math Foundations

This fixture intentionally contains many inline and display formulas so the Markdown + KaTeX autotest can verify a rich rendering path.

## Core Identities

The scalar examples below should render as inline math:

- Energy relation: $E = mc^2$
- Pythagorean identity: $a^2 + b^2 = c^2$
- Logistic function: $\sigma(x) = \frac{1}{1 + e^{-x}}$
- Softmax component: $\mathrm{softmax}(z_i) = \frac{e^{z_i}}{\sum_j e^{z_j}}$
- Mean value: $\mu = \frac{1}{n}\sum_{i=1}^{n} x_i$
- Variance: $\sigma^2 = \frac{1}{n}\sum_{i=1}^{n} (x_i - \mu)^2$
- Dot product: $x^\top y = \sum_{i=1}^{d} x_i y_i$
- Norm: $\lVert x \rVert_2 = \sqrt{\sum_{i=1}^{d} x_i^2}$
- Cross entropy: $H(p, q) = -\sum_i p_i \log q_i$
- KL divergence: $D_{KL}(p \Vert q) = \sum_i p_i \log \frac{p_i}{q_i}$
- Bayes rule: $p(y \mid x) = \frac{p(x \mid y)p(y)}{p(x)}$
- Chain rule: $\frac{d}{dx} f(g(x)) = f'(g(x))g'(x)$
- Gradient descent: $\theta_{t+1} = \theta_t - \eta \nabla_\theta L(\theta_t)$
- Momentum: $v_{t+1} = \beta v_t + (1 - \beta) g_t$
- Adam first moment: $m_t = \beta_1 m_{t-1} + (1 - \beta_1) g_t$
- Adam second moment: $v_t = \beta_2 v_{t-1} + (1 - \beta_2) g_t^2$
- Bias correction: $\hat{m}_t = \frac{m_t}{1 - \beta_1^t}$
- Attention score: $\alpha_{ij} = \frac{q_i^\top k_j}{\sqrt{d_k}}$
- Context vector: $c_i = \sum_j \mathrm{softmax}(\alpha_{ij}) v_j$
- Residual update: $h_{l+1} = h_l + F(h_l)$
- Layer norm: $\mathrm{LN}(x) = \gamma \frac{x - \mu}{\sqrt{\sigma^2 + \epsilon}} + \beta$
- ReLU: $\mathrm{ReLU}(x) = \max(0, x)$
- GELU: $\mathrm{GELU}(x) = x \Phi(x)$
- Tanh: $\tanh(x) = \frac{e^x - e^{-x}}{e^x + e^{-x}}$
- Cosine similarity: $\cos(x, y) = \frac{x^\top y}{\lVert x \rVert \lVert y \rVert}$
- Matrix trace: $\mathrm{tr}(A) = \sum_i A_{ii}$
- Determinant note: $\det(AB) = \det(A)\det(B)$
- Singular values: $A = U \Sigma V^\top$
- Eigen equation: $Av = \lambda v$
- Frobenius norm: $\lVert A \rVert_F = \sqrt{\sum_{i,j} A_{ij}^2}$
- Expectation: $\mathbb{E}[X] = \sum_x x p(x)$
- Covariance: $\mathrm{Cov}(X, Y) = \mathbb{E}[XY] - \mathbb{E}[X]\mathbb{E}[Y]$
- Entropy: $H(X) = -\sum_x p(x)\log p(x)$
- Perplexity: $\mathrm{PPL} = \exp\!\left(-\frac{1}{N}\sum_{t=1}^{N}\log p(x_t)\right)$
- Positional phase: $\theta_i = 10000^{-2i/d}$
- RoPE rotation: $R_\theta(x) = x e^{i\theta}$
- Learning-rate warmup: $\eta_t = \eta_{\max}\frac{t}{T_w}$
- Weight decay: $\theta \leftarrow (1 - \eta \lambda)\theta$
- Hessian entry: $H_{ij} = \frac{\partial^2 L}{\partial \theta_i \partial \theta_j}$
- Jacobian entry: $J_{ij} = \frac{\partial y_i}{\partial x_j}$

## Display Equations

$$
\nabla_x \left( \frac{1}{2} x^\top A x - b^\top x \right) = A x - b
$$

$$
\int_{-\infty}^{\infty} \frac{1}{\sqrt{2\pi}} e^{-x^2/2} dx = 1
$$

$$
\begin{aligned}
\mathrm{MSE}(y, \hat{y}) &= \frac{1}{n}\sum_{i=1}^{n} (y_i - \hat{y}_i)^2 \\
\nabla_{\hat{y}} \mathrm{MSE} &= \frac{2}{n}(\hat{y} - y)
\end{aligned}
$$

$$
\begin{aligned}
\mathrm{softmax}(z_i) &= \frac{e^{z_i}}{\sum_j e^{z_j}} \\
\log \mathrm{softmax}(z_i) &= z_i - \log \sum_j e^{z_j}
\end{aligned}
$$

$$
\begin{aligned}
\mathrm{Attention}(Q, K, V) &= \mathrm{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}}\right)V \\
Q, K, V &\in \mathbb{R}^{n \times d}
\end{aligned}
$$

$$
\begin{aligned}
\mu &= \frac{1}{d}\sum_{i=1}^{d} x_i \\
\sigma^2 &= \frac{1}{d}\sum_{i=1}^{d}(x_i - \mu)^2
\end{aligned}
$$

$$
\begin{aligned}
m_t &= \beta_1 m_{t-1} + (1 - \beta_1) g_t \\
v_t &= \beta_2 v_{t-1} + (1 - \beta_2) g_t^2 \\
\theta_t &= \theta_{t-1} - \eta \frac{\hat{m}_t}{\sqrt{\hat{v}_t} + \epsilon}
\end{aligned}
$$

$$
\begin{aligned}
\mathcal{L}_{CE} &= -\sum_{i=1}^{C} y_i \log \hat{y}_i \\
\frac{\partial \mathcal{L}_{CE}}{\partial z_i} &= \hat{y}_i - y_i
\end{aligned}
$$

$$
\begin{aligned}
\mathrm{PCA}: \quad \max_{W^\top W = I} \mathrm{tr}(W^\top X^\top X W)
\end{aligned}
$$

$$
\begin{aligned}
\mathrm{SVD}(A) &= U \Sigma V^\top \\
A_k &= U_k \Sigma_k V_k^\top
\end{aligned}
$$

$$
\begin{aligned}
\mathrm{KL}(p \Vert q) &= \sum_i p_i \log \frac{p_i}{q_i} \\
\mathrm{JS}(p, q) &= \frac{1}{2}\mathrm{KL}(p \Vert m) + \frac{1}{2}\mathrm{KL}(q \Vert m)
\end{aligned}
$$

$$
\begin{aligned}
\mathrm{EMA}_t &= \alpha x_t + (1 - \alpha)\mathrm{EMA}_{t-1} \\
\alpha &\in (0, 1)
\end{aligned}
$$

## Mixed Narrative

Transformer blocks alternate between self-attention $A(h)$ and feed-forward layers $F(h)$, typically composing as $h' = h + A(h)$ and $h'' = h' + F(h')$.

Optimization also depends on statistical estimates such as $\mathbb{E}[g]$, $\mathrm{Var}(g)$, and stability controls like $\lVert g \rVert_2 \leq \tau$.

For sequence models, a token probability factorization can be written as $p(x_{1:T}) = \prod_{t=1}^{T} p(x_t \mid x_{<t})$, while the training objective minimizes $-\sum_{t=1}^{T} \log p(x_t \mid x_{<t})$.
